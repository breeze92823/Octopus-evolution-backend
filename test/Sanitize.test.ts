import assert from "assert";

import { ASCEND_MAX, BOOST_SECONDS_MAX, CURRENCY_MAX, ITEMS_MAX, LEVEL_MAX, STAGE_MAX, TIMER_SECONDS_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ wins: 1e40, totalWins: -5, xp: NaN, rebirths: 3.7, level: 0, bestStage: 1e6, wins2x: "yes", starter: true, hack: "x" })!;
    assert.strictEqual(out.wins, CURRENCY_MAX);
    assert.strictEqual(out.totalWins, 0);
    assert.strictEqual(out.xp, undefined);
    assert.strictEqual(out.rebirths, 3);
    assert.strictEqual(out.level, 1, "a level is at least 1");
    assert.strictEqual(out.bestStage, STAGE_MAX);
    assert.strictEqual(out.wins2x, undefined);
    assert.strictEqual(out.starter, true);
    assert.ok(!("hack" in out));
    assert.strictEqual(sanitizeProgress({ level: 1e12 })!.level, LEVEL_MAX);
  });

  it("bounds the timers", () => {
    const out = sanitizeProgress({ train2x: -4, bossTimer: 1e9, playtime: 61.9 })!;
    assert.strictEqual(out.train2x, 0);
    assert.strictEqual(out.bossTimer, TIMER_SECONDS_MAX);
    assert.strictEqual(out.playtime, 61);
  });

  it("keeps well-formed skin and zone ids and only equips an owned skin", () => {
    const out = sanitizeProgress({ owned: ["reef", "coral", "coral", "Bad Id!", 7], equipped: "coral", zonesBought: ["space", "space", "Bad Id!"] })!;
    assert.deepStrictEqual(out.owned, ["reef", "coral"]);
    assert.strictEqual(out.equipped, "coral");
    assert.deepStrictEqual(out.zonesBought, ["space"]);
    assert.strictEqual(sanitizeProgress({ owned: ["reef"], equipped: "galaxy" })!.equipped, undefined, "not owned");
    assert.strictEqual(sanitizeProgress({ equipped: "galaxy" })!.equipped, "galaxy", "no list to check against: the shape is enough");
    assert.strictEqual(sanitizeProgress({ equipped: "" })!.equipped, undefined, "there is always a skin equipped");
  });

  it("bounds the meta progression: items, boost timers, titles, trails, ascend, stats", () => {
    const out = sanitizeProgress({
      items: { train: 2.9, wins: -1, damage: "x", speed: 1e12, hack: 5 },
      wins2xT: -3,
      dmg2xT: 1e12,
      speedT: 30,
      titles: ["hatchling", "hatchling", "Bad Id!"],
      title: "wiggler",
      titlesSeen: ["hatchling"],
      trails: ["fire"],
      trail: "fire",
      ascend: 2.7,
      stats: { kills: 12, z_jungle: 4, "bad key!": 3, neg: -2, str: "9" },
    })!;
    assert.deepStrictEqual(out.items, { train: 2, wins: 0, damage: 0, speed: ITEMS_MAX });
    assert.strictEqual(out.wins2xT, 0);
    assert.strictEqual(out.dmg2xT, BOOST_SECONDS_MAX);
    assert.strictEqual(out.speedT, 30);
    assert.deepStrictEqual(out.titles, ["hatchling"]);
    assert.strictEqual(out.title, undefined, "a title that is not earned is never equipped");
    assert.strictEqual(out.trail, "fire");
    assert.strictEqual(out.ascend, 2);
    assert.deepStrictEqual(out.stats, { kills: 12, z_jungle: 4 });
    assert.strictEqual(sanitizeProgress({ title: "", trail: "" })!.title, "", "'' = none equipped");
    assert.strictEqual(sanitizeProgress({ trails: [], trail: "fire" })!.trail, undefined, "not owned");
    assert.strictEqual(sanitizeProgress({ ascend: 1e9 })!.ascend, ASCEND_MAX);
  });
});
