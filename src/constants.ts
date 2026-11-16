// Keep in step with the client's src/config.js by hand.
export const GAME_SLUG = "octopus-evolution"; // the game / hosting id registered on bloxity.io (client GAME_SLUG)
export const ROOM_MAX_CLIENTS = 50; // players per room: 2-100 keeps Bloxity party play working

// Player identity (auth.ts): a Bloxity account id comes only from the platform's token verification.
export const USER_ID_MAX = 128;
export const USER_ID_PATTERN = /^[A-Za-z0-9_.#-]{1,128}$/;
// Local development has no Bloxity token: the client sends a per-browser `dev-xxxx` id, honoured only
// outside production (auth.ts).
export const DEV_ID_PATTERN = /^dev-[A-Za-z0-9_-]{1,32}$/;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, and the pose
// bounds (|x|, |y|, |z| up to `xy` m; speed in m/s). The hub is ~130 x 110 m and the lane runs
// north of it, so these are generous.
export const AVATAR_MAX_LEN = 3000;
export const POSE_BOUNDS = { xy: 5000, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules (client PROGRESSION / STAGES / BOOSTS in config.js).
export const CURRENCY_MAX = 1e33; // wins, totalWins, xp
export const REBIRTHS_MAX = 1e9;
export const LEVEL_MAX = 1e9; // level cap = capBase + capPerRebirth * rebirths
export const STAGE_MAX = 1000; // client STAGES.count is 15
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year
export const TIMER_SECONDS_MAX = 86_400; // x2 Train potion time left, hub boss countdown

// Owned tentacle skins / bought zones (client TENTACLES ~12, ZONES ~9), with slack.
export const OWNED_MAX = 256;

// Meta progression (client ITEMS / TITLES / TRAILS / ASCEND in config.js): held boosts per item
// kind, the item kinds, earned titles / owned trails, the Ascend tier and the title stat counters.
export const ITEM_IDS = ["train", "wins", "damage", "speed"] as const;
export const ITEMS_MAX = 1e6; // boosts held of one kind
export const BOOST_SECONDS_MAX = 7 * 86_400; // s left on a used boost (they stack)
export const ASCEND_MAX = 1000; // client ASCEND.maxTier is 60
export const STATS_KEYS_MAX = 64; // stats{} counters (kills, bosses, z_<zone>, ...)
export const STAT_MAX = 1e15;

// Daily Rewards (daily.ts): days in the calendar (client DAILY.days.length).
export const DAILY_DAYS = 7;
// Playtime Rewards (gifts.ts): minutes of play that open each gift (client PLAYTIME.gifts[].min).
export const GIFT_MINUTES = [1, 3, 6, 8, 10, 15, 20, 25, 30, 45] as const;
export const GIFT_TIME_MAX = 24 * 3600; // the gift clock never needs more than a day

// Leaderboards (leaderboard.ts; client hub boards): the saved doc fields ranked. The names are the
// client's `state` keys: Most Wins = totalWins, Most Rebirths, Most Playtime, Best Stage.
export const LEADERBOARD_STATS = ["totalWins", "rebirths", "playtime", "bestStage"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (TENTACLES, ZONES): lowercase slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Presence look (presence.ts): the Bloxity equipped-slot fields relayed to the others (ids only, never
// URLs), the body proportion sliders with the SDK's clamp ranges, and the longest outfit key.
export const LOOK_SLOTS = [
  "hatId", "backId", "skinId", "headId", "armLId", "armRId", "legLId", "legRId", "torsoId", "hairId", "maskId",
  "neckId", "chestId", "waistId", "handId", "shoesId", "faceId", "pantsId", "shirtId", "characterId",
] as const;
export const LOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const LOOK_PROPORTIONS = {
  height: [0.5, 1.6],
  shoulderWidth: [0.5, 1.5],
  armLength: [0.05, 3],
  legOffsetX: [-0.7, 5],
  torsoScaleX: [0.3, 2],
  neckHeight: [0.94, 1.2],
  headScale: [0.3, 2.6],
} as const;
export const OUTFIT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,800}$/;
// Emote catalogue ids are 24-character ids; kept opaque (new ones appear without a release).
export const EMOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

// Bloxity's own leaderboards and stats (boxity.ts; the client defines the same boards in
// config.js BLOXITY_BOARDS): board ids are lowercase and permanent (the first declaration creates a
// board; after that the dashboard owns its settings). All four only ever grow, so mode "best".
export const BOXITY_BOARDS = [
  { id: "wins", label: "Wins Earned", order: "desc", mode: "best", format: "compact", stat: "totalWins" },
  { id: "rebirths", label: "Rebirths", order: "desc", mode: "best", format: "number", stat: "rebirths" },
  { id: "stage", label: "Best Stage", order: "desc", mode: "best", format: "number", stat: "bestStage" },
  { id: "playtime", label: "Minutes Played", order: "desc", mode: "best", format: "number", stat: "playtimeMinutes" },
] as const;
// Bloxity player stats (POST /v1/games/{id}/stats): lowercase keys, `max` = the platform's ceiling
// for the type (a value above it is rejected, so it is left out rather than sent).
export const BOXITY_STATS = [
  { key: "total_wins", label: "Wins Earned", type: "number", sortOrder: 1, stat: "totalWins", max: 1e9 },
  { key: "rebirths", label: "Rebirths", type: "number", sortOrder: 2, stat: "rebirths", max: 1e9 },
  { key: "best_stage", label: "Best Stage", type: "number", sortOrder: 3, stat: "bestStage", max: 1e9 },
  { key: "octopus_level", label: "Octopus Level", type: "number", sortOrder: 4, stat: "level", max: 1e9 },
  { key: "playtime", label: "Playtime", type: "seconds", sortOrder: 5, stat: "playtime", max: 31_536_000_000 },
] as const;
export const BOXITY_FLUSH_MS = 20 * 1000;
export const BOXITY_SCORES_PER_CALL = 200;
