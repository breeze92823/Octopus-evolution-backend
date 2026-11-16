import { BOXITY_BOARDS, BOXITY_FLUSH_MS, BOXITY_SCORES_PER_CALL, BOXITY_STATS, GAME_SLUG, USER_ID_PATTERN } from "./constants.js";
import type { PlayerDoc } from "./db.js";
import { apiUrl } from "./auth.js";

// Bloxity's own leaderboards and stats (docs.bloxity.io: Leaderboards "From your game server" and
// "Report your game's stats"): the game page's boards, the trophy button in Bloxity's in-game toolbar
// and the player profile's "Only in this game" stats. Everything is reported from THIS server, from
// each signed-in player's saved progress (never straight from a client message): queued on load and
// after every saveProgress, sent in batches every BOXITY_FLUSH_MS, only the values that changed.
// Hosting injects BLOXITY_REPORT_TOKEN and BLOXITY_GAME_ID (BLOXITY_API_URL falls back to prod);
// without the token and id (local dev, tests) nothing is sent. Never throws.
//
// The game is client-authoritative, so these are the player's saved numbers, bounded by the platform
// ceilings in constants.ts (a stat above its ceiling would be rejected, so it is left out).

type Fields = Partial<Pick<PlayerDoc, "totalWins" | "rebirths" | "bestStage" | "playtime" | "level">>;
type Score = { board: string; userId: string; score: number };

const env = () => {
  const token = process.env.BLOXITY_REPORT_TOKEN;
  const gameId = process.env.BLOXITY_GAME_ID;
  return token && gameId ? { token, gameId, base: apiUrl() } : null;
};

// "<board>|<legion id>" -> score waiting to be sent / last accepted.
const pendingScores = new Map<string, Score>();
const sentScores = new Map<string, number>();
// "<legion id>" -> { stat key -> value } waiting to be sent, and "<key>|<id>" -> last accepted.
const pendingStats = new Map<string, Record<string, number>>();
const sentStats = new Map<string, number>();
const SENT_MAX = 50_000;
let declared = false;
let timer: NodeJS.Timeout | null = null;
let fetcher: typeof fetch = fetch;

// Bloxity ranks `legion_<id>` identities; ids may carry a `#m...` mode suffix. Local dev ids are never reported.
export function legionId(userId: string): string {
  const id = userId.split("#")[0];
  if (!id || id.startsWith("dev-") || !USER_ID_PATTERN.test(id)) return "";
  return id.startsWith("legion_") ? id : `legion_${id}`;
}

// The value a board ranks, from the saved fields (playtime is kept in seconds, its board counts minutes).
function boardValue(stat: string, fields: Fields): number {
  if (stat === "playtimeMinutes") return Number(fields.playtime) / 60;
  return Number(fields[stat as keyof Fields]);
}

// Queues a player's stats (the doc's fields, or a sanitized saveProgress patch).
export function reportPlayer(userId: string, fields: Fields): void {
  if (!env()) return;
  const id = legionId(userId);
  if (!id) return;
  for (const b of BOXITY_BOARDS) {
    const raw = boardValue(b.stat, fields);
    if (!Number.isFinite(raw) || raw <= 0 || raw > Number.MAX_SAFE_INTEGER) continue;
    const score = Math.floor(raw);
    const key = `${b.id}|${id}`;
    if (sentScores.get(key) === score) pendingScores.delete(key);
    else pendingScores.set(key, { board: b.id, userId: id, score });
  }
  for (const s of BOXITY_STATS) {
    const v = Number(fields[s.stat]);
    if (!Number.isFinite(v) || v < 0 || v > s.max) continue; // invalid or over the platform ceiling: omit
    const value = Math.floor(v);
    if (sentStats.get(`${s.key}|${id}`) === value) {
      const p = pendingStats.get(id);
      if (p) delete p[s.key];
    } else pendingStats.set(id, { ...pendingStats.get(id), [s.key]: value });
  }
  timer ??= setInterval(() => void flushBoxity(), BOXITY_FLUSH_MS).unref();
}

// Sends what is queued, BOXITY_SCORES_PER_CALL at a time. A failed call keeps its entries queued
// (unless newer ones replaced them meanwhile) for the next flush.
export async function flushBoxity(): Promise<void> {
  const e = env();
  if (!e) return;
  await flushScores(e);
  await flushStats(e);
  if (sentScores.size > SENT_MAX) sentScores.clear();
  if (sentStats.size > SENT_MAX) sentStats.clear();
}

async function flushScores(e: NonNullable<ReturnType<typeof env>>): Promise<void> {
  while (pendingScores.size) {
    const batch = [...pendingScores.entries()].slice(0, BOXITY_SCORES_PER_CALL);
    for (const [key] of batch) pendingScores.delete(key);
    const ok = await post(
      `${e.base}/v1/leaderboards/hosted/${encodeURIComponent(e.gameId)}/report`,
      e.token,
      // The boards ride along until one call is accepted (Bloxity's first declaration creates them).
      { ...(!declared && { boards: BOXITY_BOARDS.map(({ stat, ...b }) => b) }), scores: batch.map(([, s]) => s) },
      "leaderboards",
    );
    for (const [key, s] of batch) {
      if (ok) sentScores.set(key, s.score);
      else if (!pendingScores.has(key)) pendingScores.set(key, s);
    }
    if (!ok) return;
    declared = true;
  }
}

async function flushStats(e: NonNullable<ReturnType<typeof env>>): Promise<void> {
  const definitions = BOXITY_STATS.map(({ stat, max, ...d }) => d);
  while (pendingStats.size) {
    const batch = [...pendingStats.entries()].slice(0, BOXITY_SCORES_PER_CALL);
    for (const [id] of batch) pendingStats.delete(id);
    const ok = await post(
      `${e.base}/v1/games/${encodeURIComponent(e.gameId)}/stats`,
      e.token,
      { definitions, players: batch.map(([userId, values]) => ({ userId, values })) },
      "stats",
    );
    for (const [id, values] of batch) {
      for (const [k, v] of Object.entries(values)) {
        if (ok) sentStats.set(`${k}|${id}`, v);
      }
      if (!ok) pendingStats.set(id, { ...values, ...pendingStats.get(id) }); // newer queued values win
    }
    if (!ok) return;
  }
}

async function post(url: string, token: string, body: unknown, what: string): Promise<boolean> {
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[boxity] ${what} report answered ${res.status}`, await res.text().catch(() => ""));
      return false;
    }
    const answer: { dropped?: Record<string, number> } | null = await res.json().catch((): null => null);
    const dropped = Object.entries(answer?.dropped ?? {}).filter(([, n]) => n > 0);
    if (dropped.length) console.warn(`[boxity] ${what} dropped`, Object.fromEntries(dropped));
    return true;
  } catch (err) {
    console.warn(`[boxity] ${what} report failed`, (err as Error)?.message ?? err);
    return false;
  }
}

// What the platform was told this game is (docs: BLOXITY_GAME_ID is the hosting id = the client's slug).
export const BOXITY_GAME_SLUG = GAME_SLUG;

// Test-only: swap fetch, forget everything queued / sent.
export function __setFetchForTest(f: typeof fetch | null): void {
  fetcher = f ?? fetch;
  pendingScores.clear();
  sentScores.clear();
  pendingStats.clear();
  sentStats.clear();
  declared = false;
}
