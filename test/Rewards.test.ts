import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { DAILY_DAYS, GIFT_MINUTES } from "../src/constants.js";
import { claimDaily, readDaily, rollDaily, utcDay } from "../src/daily.js";
import { claimGift, giftTime, readGifts, settleGifts } from "../src/gifts.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("daily reward rules", () => {
  it("unlocks one day per consecutive UTC day and a missed day starts the streak over", () => {
    const s = readDaily(null);
    assert.ok(rollDaily(s, 100));
    assert.deepStrictEqual(s, { day: 1, last: 100, claimed: [], streak: 1 });
    assert.ok(!rollDaily(s, 100), "once per day");
    assert.ok(claimDaily(s, 0));
    assert.ok(rollDaily(s, 101));
    assert.strictEqual(s.day, 2);
    assert.strictEqual(s.streak, 2);
    assert.ok(rollDaily(s, 103), "a day was missed");
    assert.deepStrictEqual(s, { day: 1, last: 103, claimed: [], streak: 1 });
  });

  it("caps at the last day while days are unclaimed, then starts a new week keeping the streak", () => {
    const s = readDaily(null);
    for (let d = 200; d < 212; d++) rollDaily(s, d);
    assert.strictEqual(s.day, DAILY_DAYS);
    assert.strictEqual(s.streak, 12);
    for (let i = 0; i < DAILY_DAYS; i++) assert.ok(claimDaily(s, i));
    assert.ok(rollDaily(s, 212));
    assert.deepStrictEqual(s, { day: 1, last: 212, claimed: [], streak: 13 });
  });

  it("only claims unlocked, unclaimed days and bounds a stored state", () => {
    const s = readDaily({ dailyDay: 2, dailyLast: 7, dailyClaimed: [0, 0, 5, -1, 1.5] as number[], dailyStreak: 4 });
    assert.deepStrictEqual(s.claimed, [0]);
    assert.ok(!claimDaily(s, 0), "already claimed");
    assert.ok(!claimDaily(s, 2), "not unlocked yet");
    assert.ok(!claimDaily(s, "1"));
    assert.ok(claimDaily(s, 1));
    assert.ok(!rollDaily(s, 6), "a clock going back unlocks nothing");
    assert.strictEqual(readDaily({ dailyDay: 99 }).day, DAILY_DAYS);
  });
});

describe("playtime gift rules", () => {
  it("opens gifts by server time played, carries the clock and restarts after the last gift", () => {
    const t0 = 1_000_000;
    const s = readGifts({ giftTime: 50, giftClaimed: [0, 0, 99] as number[] }, t0);
    assert.deepStrictEqual(s.claimed, [0]);
    assert.strictEqual(claimGift(s, 1, t0), "early", "3 min not played yet");
    assert.strictEqual(claimGift(s, 1, t0 + 129_000), "ok", "50 s + 129 s + slack >= 180 s");
    assert.strictEqual(claimGift(s, 1, t0 + 129_000), "bad", "already claimed");
    assert.strictEqual(claimGift(s, "2", t0), "bad");
    settleGifts(s, t0 + 200_000);
    assert.strictEqual(s.time, 250);
    const last = GIFT_MINUTES.length - 1;
    for (let i = 2; i < last; i++) assert.strictEqual(claimGift(s, i, t0 + 3_000_000), "ok");
    assert.strictEqual(claimGift(s, last, t0 + 3_000_000), "ok");
    assert.deepStrictEqual(s.claimed, [], "a new round");
    assert.strictEqual(giftTime(s, t0 + 3_000_000), 0);
  });
});

describe("reward room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("unlocks today on join, stores daily claims and refuses a second claim", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "dev-d1", dailyDay: 1, dailyLast: today - 1, dailyClaimed: [0], dailyStreak: 1, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-d1" });
    let daily: any = null;
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("gifts", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("daily", (m: any) => (daily = m));
    c.onMessage("dailyResult", (m: any) => results.push(m));
    fake.release();
    await sleep(150);
    assert.strictEqual(daily?.unlocked, 2);
    assert.strictEqual(daily?.streak, 2);
    assert.strictEqual(daily?.persisted, true);
    assert.deepStrictEqual(daily?.claimed, [0]);
    assert.strictEqual(daily?.nextAt, (today + 1) * 86_400_000);
    assert.strictEqual((fake.docs.get("dev-d1") as any).dailyLast, today);

    c.send("claimDaily", { day: 1 });
    c.send("claimDaily", { day: 1 });
    c.send("claimDaily", { day: 2 });
    await sleep(150);
    // The good claim answers after its write, so the refusals may come first.
    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(results.filter((r) => r.ok).map((r) => r.day), [1]);
    assert.deepStrictEqual((fake.docs.get("dev-d1") as any).dailyClaimed, [0, 1]);

    // saveProgress can't touch the server-owned fields.
    c.send("saveProgress", { wins: 1, dailyDay: 7, dailyClaimed: [], giftTime: 9999 });
    await sleep(150);
    const doc = fake.docs.get("dev-d1") as any;
    assert.strictEqual(doc.dailyDay, 2);
    assert.deepStrictEqual(doc.dailyClaimed, [0, 1]);
    assert.ok(!doc.giftTime);
  });

  it("only grants a playtime gift once its minutes are played and keeps the clock on leave", async () => {
    const fake = fakePlayers([{ _id: "dev-g1", giftTime: 59.5, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-g1" });
    let gifts: any = null;
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("gifts", (m: any) => (gifts = m));
    c.onMessage("giftResult", (m: any) => results.push(m));
    fake.release();
    await sleep(150);
    assert.strictEqual(gifts?.persisted, true);
    assert.ok(gifts.time >= 59.5 && gifts.time < 62);
    c.send("claimGift", { gift: 0 });
    c.send("claimGift", { gift: 1 });
    await sleep(150);
    assert.deepStrictEqual(results.map((r) => [r.gift, r.ok, r.reason ?? ""]).sort(), [
      [0, true, ""],
      [1, false, "early"],
    ]);
    assert.deepStrictEqual((fake.docs.get("dev-g1") as any).giftClaimed, [0]);
    await c.leave();
    await sleep(150);
    assert.ok((fake.docs.get("dev-g1") as any).giftTime >= 59.5, "the clock is kept for next time");
  });

  it("tells a guest the rewards are not persisted (the client runs its local copy)", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, {});
    let daily: any = null;
    let gifts: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("daily", (m: any) => (daily = m));
    c.onMessage("gifts", (m: any) => (gifts = m));
    fake.release();
    await sleep(100);
    // A guest's load answers at once (before these handlers exist): ask again.
    c.send("dailyRefresh", {});
    c.send("claimGift", { gift: 5 });
    c.onMessage("giftResult", (m: any) => (gifts = m));
    await sleep(150);
    assert.strictEqual(daily?.persisted, false);
    assert.strictEqual(gifts?.persisted, false);
    assert.strictEqual(fake.docs.size, 0, "nothing written for a guest");
  });
});
