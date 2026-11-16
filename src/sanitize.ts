import {
  CURRENCY_MAX,
  REBIRTHS_MAX,
  LEVEL_MAX,
  STAGE_MAX,
  PLAY_SECONDS_MAX,
  TIMER_SECONDS_MAX,
  OWNED_MAX,
  ID_PATTERN,
  ITEM_IDS,
  ITEMS_MAX,
  BOOST_SECONDS_MAX,
  ASCEND_MAX,
  STATS_KEYS_MAX,
  STAT_MAX,
} from "./constants.js";
import type { PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Catalog ids (tentacle skins, zones): slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save. The keys are the client's `state`
// keys (src/state.js `fresh()`), so the client saves and loads its state object as is.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.wins)) out.wins = clampNum(raw.wins, CURRENCY_MAX);
  if (finite(raw.totalWins)) out.totalWins = clampNum(raw.totalWins, CURRENCY_MAX);
  if (finite(raw.xp)) out.xp = clampNum(raw.xp, CURRENCY_MAX);
  if (finite(raw.level)) out.level = clampInt(raw.level, LEVEL_MAX, 1);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTHS_MAX);
  if (finite(raw.bestStage)) out.bestStage = clampInt(raw.bestStage, STAGE_MAX);
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.train2x)) out.train2x = clampNum(raw.train2x, TIMER_SECONDS_MAX);
  if (finite(raw.bossTimer)) out.bossTimer = clampNum(raw.bossTimer, TIMER_SECONDS_MAX);
  if (typeof raw.wins2x === "boolean") out.wins2x = raw.wins2x;
  if (typeof raw.starter === "boolean") out.starter = raw.starter;
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);

  // Owned skins + the equipped one, which must be owned. When this save doesn't carry the list,
  // trust the id's shape only.
  if (raw.owned !== undefined) out.owned = sanitizeIds(raw.owned);
  if (isId(raw.equipped) && (!out.owned || out.owned.includes(raw.equipped))) out.equipped = raw.equipped;
  if (raw.zonesBought !== undefined) out.zonesBought = sanitizeIds(raw.zonesBought);

  // Meta progression: held boosts, boost timers, titles, trails, Ascend, title counters.
  if (isObject(raw.items)) {
    const items: Record<string, number> = {};
    for (const k of ITEM_IDS) items[k] = finite(raw.items[k]) ? clampInt(raw.items[k] as number, ITEMS_MAX) : 0;
    out.items = items;
  }
  for (const k of ["wins2xT", "dmg2xT", "speedT"] as const) if (finite(raw[k])) out[k] = clampNum(raw[k] as number, BOOST_SECONDS_MAX);
  if (raw.titles !== undefined) out.titles = sanitizeIds(raw.titles);
  if (raw.titlesSeen !== undefined) out.titlesSeen = sanitizeIds(raw.titlesSeen);
  // "" = none; otherwise an earned title / owned trail (when the list rides along).
  if (raw.title === "" || (isId(raw.title) && (!out.titles || out.titles.includes(raw.title)))) out.title = raw.title as string;
  if (raw.trails !== undefined) out.trails = sanitizeIds(raw.trails);
  if (raw.trail === "" || (isId(raw.trail) && (!out.trails || out.trails.includes(raw.trail)))) out.trail = raw.trail as string;
  if (finite(raw.ascend)) out.ascend = clampInt(raw.ascend, ASCEND_MAX);
  if (isObject(raw.stats)) {
    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.stats).slice(0, STATS_KEYS_MAX)) if (isId(k) && finite(v) && v > 0) stats[k] = clampNum(v, STAT_MAX);
    out.stats = stats;
  }
  return out;
}
