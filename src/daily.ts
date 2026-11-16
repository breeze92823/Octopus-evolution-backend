import { DAILY_DAYS } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Daily Rewards (client src/rewards.js, DAILY.days): a 7-day streak calendar on the SERVER's clock
// (UTC days), so a changed device clock can't unlock anything. Coming back on the very next UTC day
// unlocks one more day (up to DAILY_DAYS) and grows the streak; missing a day starts the streak AND
// the calendar over at day 1 (unclaimed days are lost). Once all DAILY_DAYS are claimed, the next
// day starts a fresh week while the streak keeps counting. Unlike the rest of the save, the client
// never writes these fields: claims go through `claimDaily` (WorldRoom.ts) and only then does the
// client grant the reward.
export interface DailyState {
  day: number; // days unlocked this week (0..DAILY_DAYS)
  last: number; // UTC day index (utcDay) of the last unlock, -1 = never
  claimed: number[]; // claimed day indexes (0-based) this week
  streak: number; // consecutive days played
}

const DAY_MS = 86_400_000;
export const utcDay = (ms = Date.now()) => Math.floor(ms / DAY_MS);

// The saved state from a player's doc (null / missing fields = a new player), bounded.
export function readDaily(doc: Partial<PlayerDoc> | null): DailyState {
  const day = Number.isInteger(doc?.dailyDay) ? Math.min(DAILY_DAYS, Math.max(0, doc!.dailyDay!)) : 0;
  const last = Number.isInteger(doc?.dailyLast) ? doc!.dailyLast! : -1;
  const raw = Array.isArray(doc?.dailyClaimed) ? doc!.dailyClaimed! : [];
  const claimed = [...new Set(raw.filter((i) => Number.isInteger(i) && i >= 0 && i < day))].sort((a, b) => a - b);
  const streak = Number.isInteger(doc?.dailyStreak) ? Math.max(0, doc!.dailyStreak!) : day > 0 ? 1 : 0;
  return { day, last, claimed, streak };
}

// Unlocks today's day if it isn't yet. Returns true when the state changed (save it).
export function rollDaily(s: DailyState, today = utcDay()): boolean {
  if (s.last >= today) return false; // already rolled today (or the clock went back)
  const nextDay = s.day > 0 && s.last === today - 1;
  if (!nextDay) {
    // New player, or a missed day: the streak starts over.
    s.day = 1;
    s.claimed = [];
    s.streak = 1;
  } else {
    if (s.claimed.length >= DAILY_DAYS) {
      s.day = 1;
      s.claimed = [];
    } else s.day = Math.min(DAILY_DAYS, s.day + 1);
    s.streak++;
  }
  s.last = today;
  return true;
}

// Claims day `i` (0-based) if it is unlocked and unclaimed.
export function claimDaily(s: DailyState, i: unknown): boolean {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= s.day || s.claimed.includes(i as number)) return false;
  s.claimed.push(i as number);
  s.claimed.sort((a, b) => a - b);
  return true;
}

// What the client is sent: the state plus when the next UTC day starts (server clock).
export function dailyView(s: DailyState, now = Date.now()) {
  return { unlocked: s.day, claimed: [...s.claimed], streak: s.streak, nextAt: (utcDay(now) + 1) * DAY_MS, serverTime: now };
}

// The doc fields that store it.
export const dailyFields = (s: DailyState) => ({ dailyDay: s.day, dailyLast: s.last, dailyClaimed: [...s.claimed], dailyStreak: s.streak });
