import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { installRoomReporter } from "./legion-room-reporter.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
listen(app);

// Pushes this pod's rooms to the Bloxity matchmaker every 2 s, which is what fills the game page's
// "Open Rooms" list and makes its Join button (?roomId=) work across pods. A no-op outside a Bloxity
// deployment (BLOXITY_REPORT_TOKEN / MATCHMAKER_REPORT_URL are injected by hosting).
installRoomReporter();
