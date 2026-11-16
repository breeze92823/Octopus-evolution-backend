import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { applyAvatar, applyEmote, applyLoadout, applyPose } from "../presence.js";
import { devIdentity, verifyToken, type Identity } from "../auth.js";
import { flushBoxity, reportPlayer } from "../boxity.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, utcDay, type DailyState } from "../daily.js";
import { claimGift, giftFields, giftsView, readGifts, settleGifts, type GiftState } from "../gifts.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

type JoinOptions = { token?: string; devId?: string; username?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: unknown };
type Auth = Identity & { guest: boolean };

/**
 * Room every client joins via `client.joinOrCreate("world", { token, username, pfp, loadout, avatar })`.
 * Who the player is comes ONLY from Bloxity's verification of `token` (onAuth -> auth.ts); a guest
 * (no / refused token) is never loaded or saved. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // Daily Rewards (daily.ts) and Playtime Rewards (gifts.ts) per session, read from the doc on load.
  // Server-owned: only the claim messages below change them (saveProgress never carries them).
  private dailies = new Map<string, DailyState>();
  private gifts = new Map<string, GiftState>();
  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The records (Wins earned, best stage, playtime) only ever go up ($max), so a stale tab or a
      // replayed save can't lower them.
      const { totalWins, bestStage, playtime, ...rest } = patch;
      const records = { ...(totalWins !== undefined && { totalWins }), ...(bestStage !== undefined && { bestStage }), ...(playtime !== undefined && { playtime }) };
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(Object.keys(records).length > 0 && { $max: records }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
        return;
      }
      reportPlayer(userId, patch); // Bloxity boards + stats, from what is now stored
    },
    // Presence (presence.ts): the sender's pose ~10x/s, its equipped gear and its Bloxity look,
    // relayed through the roster so every client can draw them in the world.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // The emote the sender picked in Bloxity's emote wheel ({ id }), or { id: "" } when it stopped.
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // Daily Rewards: `claimDaily` { day } (0-based) -> `dailyResult` { ok, day, reason?, ...view }. ok only
    // once stored, so the client grants the reward exactly once. `dailyRefresh` re-rolls after
    // midnight -> `daily`.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const sid = client.sessionId;
      const s = this.dailies.get(sid);
      const day = msg?.day;
      if (!s || !this.loaded.has(sid)) return this.reply(client, "dailyResult", { ok: false, day, reason: "loading" });
      rollDaily(s, utcDay());
      if (!claimDaily(s, day)) return this.reply(client, "dailyResult", { ok: false, day, reason: "locked", ...this.dailyMsg(sid, s) });
      if (!(await this.saveRewards(sid, dailyFields(s)))) {
        s.claimed = s.claimed.filter((i) => i !== day);
        return this.reply(client, "dailyResult", { ok: false, day, reason: "save", ...this.dailyMsg(sid, s) });
      }
      this.reply(client, "dailyResult", { ok: true, day, ...this.dailyMsg(sid, s) });
    },
    dailyRefresh: async (client: Client) => {
      const sid = client.sessionId;
      const s = this.dailies.get(sid);
      if (!s || !this.loaded.has(sid)) return;
      if (rollDaily(s, utcDay())) await this.saveRewards(sid, dailyFields(s));
      this.reply(client, "daily", this.dailyMsg(sid, s));
    },
    // Playtime Rewards: `claimGift` { gift } -> `giftResult` { ok, gift, reason?: "loading" | "bad" |
    // "early" | "save", ...view }, ok only once stored.
    claimGift: async (client: Client, msg: { gift?: unknown }) => {
      const sid = client.sessionId;
      const s = this.gifts.get(sid);
      const gift = msg?.gift;
      if (!s || !this.loaded.has(sid)) return this.reply(client, "giftResult", { ok: false, gift, reason: "loading" });
      const before = { time: s.time, since: s.since, claimed: [...s.claimed] };
      const res = claimGift(s, gift);
      if (res !== "ok") return this.reply(client, "giftResult", { ok: false, gift, reason: res, ...this.giftsMsg(sid, s) });
      settleGifts(s);
      if (!(await this.saveRewards(sid, giftFields(s)))) {
        Object.assign(s, before);
        return this.reply(client, "giftResult", { ok: false, gift, reason: "save", ...this.giftsMsg(sid, s) });
      }
      this.reply(client, "giftResult", { ok: true, gift, ...this.giftsMsg(sid, s) });
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session): { token, devId?, username, pfp }. The token is verified again; the server answers
    // with progress/noProgress for the new identity.
    identify: async (client: Client, msg: { token?: string; devId?: string; username?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const auth = await this.authenticate(msg);
      if (this.state.players.get(client.sessionId) !== p) return; // left meanwhile
      p.username = sanitizeName(auth.username) || (auth.guest ? "Guest" : "Player");
      p.pfp = sanitizePfp(auth.pfp) || sanitizePfp(msg?.pfp);
      this.setUserId(client, p, auth.userId);
    },
  };

  // Signed-in with a database: the rewards are the server's (the client follows these views). Guests
  // and serverless sessions get persisted: false and run the client's local copy instead.
  private persisted(sid: string) {
    return !!this.userIds.get(sid) && !!getPlayers();
  }
  private dailyMsg(sid: string, s: DailyState) {
    return { ...dailyView(s), persisted: this.persisted(sid) };
  }
  private giftsMsg(sid: string, s: GiftState) {
    return { ...giftsView(s), persisted: this.persisted(sid) };
  }
  private reply(client: Client, type: string, msg: object) {
    try {
      client.send(type, msg);
    } catch {
      // Gone meanwhile.
    }
  }
  // Writes server-owned reward fields. True when stored -- or when there is nothing to store to (a
  // guest / no database: the session's memory is the whole state).
  private async saveRewards(sid: string, fields: Partial<PlayerDoc>): Promise<boolean> {
    const userId = this.userIds.get(sid);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne({ _id: userId }, { $set: fields, $setOnInsert: { version: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saving rewards failed", err);
      return false;
    }
  }

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
  }

  // `leaderboard` { boards: { totalWins|rebirths|playtime|bestStage: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  // Bloxity rule: the account id is only ever what the platform's token verification returns.
  // Local development (no SDK, no token) may use a `dev-` id outside production. Everyone else is a guest.
  private async authenticate(options?: { token?: unknown; devId?: unknown; username?: unknown }): Promise<Auth> {
    const verified = (await verifyToken(options?.token)) ?? devIdentity(options);
    if (verified) return { ...verified, guest: false };
    return { userId: "", username: sanitizeName(options?.username) || "Guest", pfp: "", guest: true };
  }

  async onAuth(_client: Client, options?: JoinOptions): Promise<Auth> {
    return this.authenticate(options);
  }

  onJoin(client: Client, options: JoinOptions | undefined, auth: Auth) {
    const p = new PlayerState();
    p.username = sanitizeName(auth.username) || (auth.guest ? "Guest" : "Player");
    p.pfp = sanitizePfp(auth.pfp) || sanitizePfp(options?.pfp);
    p.uid = auth.userId;
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    this.setUserId(client, p, auth.userId);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Sends what is still queued for Bloxity before the room goes away (a deploy / scale-down).
  async onDispose() {
    await flushBoxity();
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    // The playtime-gift clock ran while connected: keep it for the next session.
    const g = this.loaded.has(sessionId) ? this.gifts.get(sessionId) : undefined;
    if (g) settleGifts(g);
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now(), ...(g && giftFields(g)) } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.gifts.delete(sessionId);
  }

  // Sets the session's verified account id ("" = guest). Called from both onJoin and `identify`;
  // answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, userId: string) {
    p.uid = userId;
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    if (prev && this.loaded.has(client.sessionId)) void this.stampLastSeen(client.sessionId); // the old identity's gift clock
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
        p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    // Rewards: today's daily unlock (stored at once) and the playtime-gift clock, then their views.
    const daily = readDaily(doc);
    const rolled = rollDaily(daily, utcDay(now));
    this.dailies.set(client.sessionId, daily);
    this.gifts.set(client.sessionId, readGifts(doc, now));
    if (rolled) void this.saveRewards(client.sessionId, dailyFields(daily));
    if (!doc) client.send("noProgress", { serverTime: now });
    else {
      client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
      if (userId) reportPlayer(userId, doc); // what the platform's boards should show for them
    }
    this.reply(client, "daily", this.dailyMsg(client.sessionId, daily));
    this.reply(client, "gifts", this.giftsMsg(client.sessionId, this.gifts.get(client.sessionId)!));
    void this.sendLeaderboard(client);
  }
}
