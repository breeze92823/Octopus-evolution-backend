import { GIFT_MINUTES, GIFT_TIME_MAX } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Playtime Rewards (client src/rewards.js, PLAYTIME.gifts): gift i opens after GIFT_MINUTES[i]
// minutes of play, counted by the SERVER while the player is connected (and carried across sessions
// in the doc). Once every gift is claimed the clock starts over at 0. Like the daily calendar, the
// client never writes these fields: claims go through `claimGift` (WorldRoom.ts) and only then does
// the client grant the reward.
export interface GiftState {
  time: number; // s played this round, as of `since`
  since: number; // server ms when `time` was read (the clock runs from here while connected)
  claimed: number[]; // claimed gift indexes this round
}

const clampTime = (t: number) => Math.min(GIFT_TIME_MAX, Math.max(0, t));

export function readGifts(doc: Partial<PlayerDoc> | null, now = Date.now()): GiftState {
  const time = typeof doc?.giftTime === "number" && Number.isFinite(doc.giftTime) ? clampTime(doc.giftTime) : 0;
  const raw = Array.isArray(doc?.giftClaimed) ? doc!.giftClaimed! : [];
  const claimed = [...new Set(raw.filter((i) => Number.isInteger(i) && i >= 0 && i < GIFT_MINUTES.length))].sort((a, b) => a - b);
  return { time, since: now, claimed };
}

// Seconds played this round, right now.
export const giftTime = (s: GiftState, now = Date.now()) => clampTime(s.time + Math.max(0, now - s.since) / 1000);

// Folds the running clock into `time` (before saving, and when the player leaves).
export function settleGifts(s: GiftState, now = Date.now()): void {
  s.time = giftTime(s, now);
  s.since = now;
}

// Claims gift `i` if its minutes have been played and it is unclaimed. `slack` s of leeway cover the
// client's clock running a little ahead of the server's. The last claim of a round starts the next.
export function claimGift(s: GiftState, i: unknown, now = Date.now(), slack = 2): "ok" | "bad" | "early" {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= GIFT_MINUTES.length || s.claimed.includes(i as number)) return "bad";
  if (giftTime(s, now) + slack < GIFT_MINUTES[i as number] * 60) return "early";
  s.claimed.push(i as number);
  s.claimed.sort((a, b) => a - b);
  if (s.claimed.length >= GIFT_MINUTES.length) {
    s.claimed = [];
    s.time = 0;
    s.since = now;
  }
  return "ok";
}

// What the client is sent.
export const giftsView = (s: GiftState, now = Date.now()) => ({ time: giftTime(s, now), claimed: [...s.claimed], serverTime: now });

// The doc fields that store it (settle first).
export const giftFields = (s: GiftState) => ({ giftTime: s.time, giftClaimed: [...s.claimed] });
