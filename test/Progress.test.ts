import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([{ _id: "dev-u1", wins: 5000, owned: ["reef", "coral"], equipped: "coral", level: 12, bestStage: 7, totalWins: 9000, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.wins, 5000);
    assert.deepStrictEqual(got?.owned, ["reef", "coral"]);
    assert.strictEqual(got?.equipped, "coral");
    assert.strictEqual(got?.level, 12);
    assert.strictEqual(got?.bestStage, 7);

    c.send("saveProgress", { wins: 7000, level: 13, bestStage: 3, totalWins: 100, owned: ["reef", "coral", "lagoon"], equipped: "lagoon", zonesBought: ["space"], hack: 1 });
    await sleep(150);
    const doc = fake.docs.get("dev-u1")! as any;
    assert.strictEqual(doc.wins, 7000);
    assert.strictEqual(doc.level, 13);
    assert.strictEqual(doc.equipped, "lagoon");
    assert.deepStrictEqual(doc.zonesBought, ["space"]);
    assert.strictEqual(doc.bestStage, 7, "the best stage never goes down");
    assert.strictEqual(doc.totalWins, 9000, "Wins earned never goes down");
    assert.strictEqual(doc.username, "Ann");
    assert.ok(!("hack" in doc));
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { wins: 10 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-new1")?.wins, 10);

    const guest = await colyseus.connectTo(room, {});
    guest.onMessage("noProgress", () => {});
    await sleep(150);
    guest.send("saveProgress", { wins: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "dev-u2", wins: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, {});
    let got: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    c.send("identify", { devId: "dev-u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.wins, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "dev-u3", wins: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { wins: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-u3")!.wins, 1e9, "the unread save is never overwritten");
  });
});
