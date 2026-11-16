import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a verified Bloxity id: only signed-in players are saved
    uid: t.string().default(""), // the verified Bloxity account id ("" = guest): matches Bloxity chat's userId
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar`): what the others draw in the world.
    x: t.float64().default(0), // feet position, hub coordinates (+X east, +Z south)
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad
    speed: t.float32().default(0), // m/s
    tentacle: t.string().default(""), // equipped tentacle skin id (client TENTACLES), "" = default
    level: t.uint32().default(1), // octopus level: its size and arm count
    title: t.string().default(""), // equipped title id (client TITLES), "" = none
    trail: t.string().default(""), // equipped trail id (client TRAILS), "" = none
    ascend: t.uint32().default(0), // Ascend tier (a bigger octopus)
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, outfitKey } (ids only), "" = default
    emote: t.string().default(""), // Bloxity emote id being played ("" = none)
    emoteSeq: t.uint32().default(0), // counts emote starts, so the same emote can play again
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
