import { ASCEND_MAX, AVATAR_MAX_LEN, EMOTE_ID_PATTERN, ID_PATTERN, LEVEL_MAX, LOOK_ID_PATTERN, LOOK_PROPORTIONS, LOOK_SLOTS, OUTFIT_KEY_PATTERN, POSE_BOUNDS } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world (client remotePlayers.js).
// Relayed through the roster, only bounded here -- like the rest of the game it is client-authoritative
// and purely cosmetic. The look is the one thing that is rebuilt (ids only, see sanitizeLook).

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// `pose` { x, y, z, yaw, speed }: the octopus' feet position (hub coordinates, +X east, +Z south),
// heading (rad) and speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.xy, b.xy);
  if (finite(m.z)) p.z = clamp(m.z, -b.xy, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
}

// `loadout` { tentacle, level, title, trail, ascend }: the equipped tentacle skin id, the octopus'
// level (its size and arm count follow from it), the equipped title and trail ids ("" = none) and
// the Ascend tier (bigger octopus).
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (isId(m.tentacle)) p.tentacle = m.tentacle;
  if (finite(m.level)) p.level = Math.min(LEVEL_MAX, Math.max(1, Math.floor(m.level)));
  if (m.title === "" || isId(m.title)) p.title = m.title as string;
  if (m.trail === "" || isId(m.trail)) p.trail = m.trail as string;
  if (finite(m.ascend)) p.ascend = Math.min(ASCEND_MAX, Math.max(0, Math.floor(m.ascend)));
}

// The Bloxity look as the others will draw it: JSON { equipped, proportions, outfitKey }. Only slot ids
// (never URLs: each client builds the CDN / skin-texture URLs itself), the seven body proportions and
// the outfit key survive, so nothing a client sends can point another client at an arbitrary URL.
// Returns "" (= the default look) for anything malformed.
export function sanitizeLook(raw: unknown): string {
  let look: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > AVATAR_MAX_LEN) return "";
    try {
      look = JSON.parse(raw);
    } catch {
      return "";
    }
  }
  if (!look || typeof look !== "object") return "";
  const src = look as Record<string, unknown>;
  const out: { equipped: Record<string, string>; proportions?: Record<string, number>; outfitKey?: string } = { equipped: {} };
  const eq = src.equipped;
  if (eq && typeof eq === "object") {
    for (const slot of LOOK_SLOTS) {
      const v = (eq as Record<string, unknown>)[slot];
      const id = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
      if (typeof id === "string" && LOOK_ID_PATTERN.test(id)) out.equipped[slot] = id;
    }
  }
  const pr = src.proportions;
  if (pr && typeof pr === "object") {
    const proportions: Record<string, number> = {};
    for (const [key, [lo, hi]] of Object.entries(LOOK_PROPORTIONS)) {
      const v = (pr as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) proportions[key] = Math.min(hi, Math.max(lo, v));
    }
    if (Object.keys(proportions).length) out.proportions = proportions;
  }
  if (typeof src.outfitKey === "string" && OUTFIT_KEY_PATTERN.test(src.outfitKey)) out.outfitKey = src.outfitKey;
  if (!Object.keys(out.equipped).length && !out.outfitKey) return "";
  const json = JSON.stringify(out);
  return json.length <= AVATAR_MAX_LEN ? json : "";
}

// `setAvatar` { avatar }: the Bloxity look (sanitizeLook), "" = default.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const m = msg as { avatar?: unknown } | undefined;
  if (m?.avatar === undefined) return;
  p.avatar = sanitizeLook(m.avatar);
}

// `emote` { id }: the Bloxity emote the player started ("" = stopped). The id stays an opaque
// catalogue id; `emoteSeq` counts starts so a repeated emote plays again on the others' clients.
export function applyEmote(p: PlayerState, msg: unknown): void {
  const id = (msg as { id?: unknown } | undefined)?.id;
  if (id === "" || (typeof id === "string" && EMOTE_ID_PATTERN.test(id))) {
    p.emote = id;
    if (id) p.emoteSeq = (p.emoteSeq + 1) >>> 0;
  }
}
