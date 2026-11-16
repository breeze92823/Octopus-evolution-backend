import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setFetchForTest as setAuthFetch, devIdentity, verifyToken } from "../src/auth.js";
import { __setFetchForTest as setBoxityFetch, flushBoxity, legionId, reportPlayer } from "../src/boxity.js";
import { __setFetchForTest as setReporterFetch, installRoomReporter, reportRoomsOnce } from "../src/legion-room-reporter.js";
import { sanitizeLook } from "../src/presence.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("look and emotes", () => {
  it("keeps only slot ids, clamped proportions and the outfit key", () => {
    const out = JSON.parse(
      sanitizeLook(
        JSON.stringify({
          equipped: { hatId: "abc123", skinId: 3, handId: "http://evil/x.png", bogus: "x", pantsId: "-1" },
          proportions: { height: 9, headScale: "x", armLength: 0.5, nope: 1 },
          outfitKey: "o1_s69cb",
          skin: "https://evil.example/skin.png",
        }),
      ),
    );
    assert.deepStrictEqual(out.equipped, { hatId: "abc123", skinId: "3", pantsId: "-1" }, "URLs and unknown slots are dropped");
    assert.deepStrictEqual(out.proportions, { height: 1.6, armLength: 0.5 }, "clamped to the SDK ranges");
    assert.strictEqual(out.outfitKey, "o1_s69cb");
    assert.ok(!("skin" in out));
    assert.strictEqual(sanitizeLook("not json"), "");
    assert.strictEqual(sanitizeLook(JSON.stringify({ equipped: {} })), "", "an empty look is the default look");
    assert.notStrictEqual(sanitizeLook({ equipped: { hatId: "a" } }), "", "an object works too");
  });

  describe("on the roster", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => (colyseus = await testServer()));
    beforeEach(async () => await colyseus.cleanup());

    it("relays emotes and counts each start", async () => {
      const room = await colyseus.createRoom<WorldState>("world", {});
      const a = await colyseus.connectTo(room, {});
      await sleep(50);
      const p = room.state.players.get(a.sessionId)!;
      a.send("emote", { id: "000000000000000000000e01" });
      await sleep(50);
      assert.deepStrictEqual([p.emote, p.emoteSeq], ["000000000000000000000e01", 1]);
      a.send("emote", { id: "000000000000000000000e01" });
      await sleep(50);
      assert.strictEqual(p.emoteSeq, 2, "the same emote can play again");
      a.send("emote", { id: "bad id!" });
      a.send("emote", { id: "" });
      await sleep(50);
      assert.deepStrictEqual([p.emote, p.emoteSeq], ["", 2], "a malformed id is ignored, an empty one stops it");
    });
  });
});

describe("identity", () => {
  afterEach(() => setAuthFetch(null));

  it("takes the account id only from the platform verification", async () => {
    let seen: { url: string; auth: string | null; body: string } | null = null;
    setAuthFetch((async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization, body: String(init.body) };
      return json({ valid: true, user: { _id: "u_123", username: "ann", displayName: "Ann", pfp: "/pfp/1.png" } });
    }) as typeof fetch);
    const who = await verifyToken("tok");
    assert.deepStrictEqual(who, { userId: "u_123", username: "Ann", pfp: "/pfp/1.png" });
    assert.ok(seen!.url.endsWith("/v1/auth/game-token/verify"));
    assert.strictEqual(seen!.auth, "Bearer tok");
    assert.deepStrictEqual(JSON.parse(seen!.body), { gameSlug: "octopus-evolution" });
  });

  it("treats a missing, refused or broken token as a guest", async () => {
    assert.strictEqual(await verifyToken(undefined), null);
    setAuthFetch((async () => json({ error: "no" }, 401)) as typeof fetch);
    assert.strictEqual(await verifyToken("bad"), null);
    setAuthFetch((async () => {
      throw new Error("down");
    }) as typeof fetch);
    assert.strictEqual(await verifyToken("tok"), null);
  });

  it("honours a dev id only outside production", () => {
    assert.strictEqual(devIdentity({ devId: "dev-abc", username: "Me" })?.userId, "dev-abc");
    assert.strictEqual(devIdentity({ devId: "guest-abc" }), null);
    assert.strictEqual(devIdentity({ devId: "u_123" }), null, "a real-looking id is never accepted from the client");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.strictEqual(devIdentity({ devId: "dev-abc" }), null);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("a room ignores a client-claimed account id", async () => {
    const colyseus = await testServer();
    await colyseus.cleanup();
    const fake = fakePlayers([{ _id: "victim", wins: 99, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    try {
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { userId: "victim", profileId: "victim", devId: "victim", username: "Evil" });
      c.onMessage("noProgress", () => {});
      c.onMessage("progress", () => assert.fail("must not load another account's save"));
      fake.release();
      await sleep(150);
      c.send("saveProgress", { wins: 0 });
      await sleep(100);
      assert.strictEqual(fake.docs.get("victim")!.wins, 99);
      assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, false);
    } finally {
      __setPlayersForTest(null);
    }
  });
});

describe("Bloxity reports", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setBoxityFetch(null);
  });

  it("maps a legion id and skips dev ids", () => {
    assert.strictEqual(legionId("abc123"), "legion_abc123");
    assert.strictEqual(legionId("legion_abc#m2"), "legion_abc");
    assert.strictEqual(legionId("dev-x"), "");
  });

  it("sends nothing without the hosting token", async () => {
    delete process.env.BLOXITY_REPORT_TOKEN;
    delete process.env.BLOXITY_GAME_ID;
    let calls = 0;
    setBoxityFetch((async () => (calls++, json({ ok: true }))) as typeof fetch);
    reportPlayer("abc", { totalWins: 5, bestStage: 2 });
    await flushBoxity();
    assert.strictEqual(calls, 0);
  });

  it("reports boards and stats from saved values, once per change", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "rt";
    process.env.BLOXITY_GAME_ID = "octopus-evolution";
    process.env.BLOXITY_API_URL = "https://api.test";
    const calls: { url: string; auth: string; body: any }[] = [];
    setBoxityFetch((async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) });
      return json({ ok: true, accepted: 1, dropped: {} });
    }) as typeof fetch);

    reportPlayer("abc", { totalWins: 1234.9, rebirths: 2, bestStage: 7, playtime: 600, level: 30 });
    reportPlayer("dev-local", { totalWins: 9 }); // never reported
    await flushBoxity();

    const boards = calls.find((c) => c.url.includes("/leaderboards/hosted/"))!;
    assert.strictEqual(boards.url, "https://api.test/v1/leaderboards/hosted/octopus-evolution/report");
    assert.strictEqual(boards.auth, "Bearer rt");
    assert.deepStrictEqual(boards.body.boards.map((b: any) => b.id), ["wins", "rebirths", "stage", "playtime"]);
    assert.ok(boards.body.boards.every((b: any) => !("stat" in b)));
    const score = (id: string) => boards.body.scores.find((s: any) => s.board === id);
    assert.deepStrictEqual(score("wins"), { board: "wins", userId: "legion_abc", score: 1234 });
    assert.strictEqual(score("stage").score, 7);
    assert.strictEqual(score("playtime").score, 10, "playtime is reported in minutes");
    assert.ok(boards.body.scores.every((s: any) => s.userId === "legion_abc"));

    const stats = calls.find((c) => c.url.endsWith("/v1/games/octopus-evolution/stats"))!;
    assert.deepStrictEqual(stats.body.players, [{ userId: "legion_abc", values: { total_wins: 1234, rebirths: 2, best_stage: 7, octopus_level: 30, playtime: 600 } }]);
    assert.deepStrictEqual(stats.body.definitions.map((d: any) => d.key), ["total_wins", "rebirths", "best_stage", "octopus_level", "playtime"]);

    // Nothing changed: nothing is sent again. A raised value is.
    calls.length = 0;
    reportPlayer("abc", { totalWins: 1234.9, bestStage: 7 });
    await flushBoxity();
    assert.strictEqual(calls.length, 0);
    reportPlayer("abc", { bestStage: 8 });
    await flushBoxity();
    const again = calls.find((c) => c.url.includes("/leaderboards/"))!;
    assert.strictEqual(again.body.scores[0].score, 8);
    assert.ok(!again.body.boards, "boards are declared once");
  });

  it("leaves a stat above the platform ceiling out", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "rt";
    process.env.BLOXITY_GAME_ID = "octopus-evolution";
    const calls: any[] = [];
    setBoxityFetch((async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(String(init.body)) }), json({ ok: true }))) as typeof fetch);
    reportPlayer("big", { totalWins: 5e12, rebirths: 1 });
    await flushBoxity();
    const stats = calls.find((c) => c.url.endsWith("/stats"))!;
    assert.deepStrictEqual(stats.body.players[0].values, { rebirths: 1 }, "total_wins is over 1e9");
  });
});

describe("room reporter", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setReporterFetch(null);
  });

  it("is a no-op outside a Bloxity deployment", async () => {
    delete process.env.BLOXITY_REPORT_TOKEN;
    delete process.env.MATCHMAKER_REPORT_URL;
    assert.strictEqual(await reportRoomsOnce(), false);
    installRoomReporter(); // does not start a timer
  });

  it("pushes this pod's rooms to the matchmaker directory", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "rt";
    process.env.MATCHMAKER_REPORT_URL = "https://mm.test/v1/dir";
    process.env.BLOXITY_GAME_ID = "octopus-evolution";
    process.env.POD_NAME = "pod-1";
    const colyseus = await testServer();
    await colyseus.cleanup();
    await colyseus.createRoom<WorldState>("world", {});
    let seen: { url: string; auth: string; body: any } | null = null;
    setReporterFetch((async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) };
      return json({ ok: true });
    }) as typeof fetch);
    assert.strictEqual(await reportRoomsOnce(), true);
    assert.strictEqual(seen!.url, "https://mm.test/v1/dir/octopus-evolution/rooms");
    assert.strictEqual(seen!.auth, "Bearer rt");
    assert.strictEqual(seen!.body.podName, "pod-1");
    assert.ok(seen!.body.rooms.some((r: any) => r.name === "world" && r.maxClients === 50 && r.private === false));
  });
});
