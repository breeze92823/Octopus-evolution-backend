import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The keys are the
// client's `state` keys (src/state.js `fresh()`). This document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  wins?: number; // the Wins balance (the shop currency)
  totalWins?: number; // Wins ever earned (Most Wins board, only ever goes up)
  level?: number; // octopus level, capped per rebirth
  xp?: number; // XP into the current level
  rebirths?: number;
  owned?: string[]; // owned tentacle skin ids (client TENTACLES)
  equipped?: string; // the equipped skin (an owned one)
  zonesBought?: string[]; // premium (Wins-priced) training zone ids bought (client ZONES)
  bestStage?: number; // highest lane stage cleared (only ever goes up)
  playtime?: number; // s with the game running (only ever goes up)
  train2x?: number; // s left on the x2 Train potion
  wins2x?: boolean; // permanent x2 Wins bought
  starter?: boolean; // the one-time starter pack bought
  bossTimer?: number; // s until the hub boss drops
  lastSeen?: number; // epoch ms of the last activity
  items?: Record<string, number>; // boosts held, by ITEM_IDS kind (My Items)
  wins2xT?: number; // s left on the x2 Wins boost
  dmg2xT?: number; // s left on the x2 Damage boost
  speedT?: number; // s left on the Speed boost
  titles?: string[]; // earned title ids (client TITLES)
  title?: string; // the equipped title ("" = none; must be earned)
  titlesSeen?: string[]; // earned titles the player has looked at (the "!" badge)
  trails?: string[]; // owned trail ids (client TRAILS)
  trail?: string; // the equipped trail ("" = none; must be owned)
  ascend?: number; // Ascend tier
  stats?: Record<string, number>; // title counters (kills, bosses, giants, throws, hits, z_<zone>, ...)
  // Server-owned (never written by saveProgress): Daily Rewards (daily.ts) and Playtime Rewards (gifts.ts).
  dailyDay?: number;
  dailyLast?: number;
  dailyClaimed?: number[];
  dailyStreak?: number;
  giftTime?: number;
  giftClaimed?: number[];
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
