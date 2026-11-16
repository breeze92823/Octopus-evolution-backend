import { DEV_ID_PATTERN, GAME_SLUG, NAME_MAX, USER_ID_MAX } from "./constants.js";

// Who is joining. Bloxity rule: the account id comes ONLY from the platform's verification of the
// player's game token, never from anything the client claims. A missing, refused (401) or
// unverifiable token is a guest -- nothing is loaded or saved for guests and the client's own id is
// never a fallback. Docs: docs.bloxity.io (auth.getToken -> POST /v1/auth/game-token/verify).

export interface Identity {
  userId: string; // "" = guest
  username: string;
  pfp: string; // as Bloxity reports it (may be a relative CDN path: WorldRoom only relays http(s) ones)
}

export const apiUrl = (): string => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");

let fetcher: typeof fetch = fetch;

const TOKEN_MAX = 4096;

// The verified account for a token, or null for a guest. Never throws.
export async function verifyToken(token: unknown): Promise<Identity | null> {
  if (typeof token !== "string" || !token || token.length > TOKEN_MAX) return null;
  try {
    const res = await fetcher(`${apiUrl()}/v1/auth/game-token/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ gameSlug: GAME_SLUG }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null; // 401 = a guest; anything else = could not verify: still no identity
    const body = (await res.json().catch((): null => null)) as { valid?: boolean; user?: Record<string, unknown> } | null;
    const user = body?.user;
    if (!user || body?.valid === false) return null;
    const id = user._id ?? user.id;
    if (typeof id !== "string" || !id || id.length > USER_ID_MAX) return null;
    const name = [user.displayName, user.username].find((n): n is string => typeof n === "string" && n.length > 0) ?? "";
    return { userId: id, username: name.slice(0, NAME_MAX), pfp: typeof user.pfp === "string" ? user.pfp : "" };
  } catch (err) {
    console.warn("[auth] token verification failed", (err as Error)?.message ?? err);
    return null;
  }
}

// Local development has no Bloxity SDK and so no token: the client sends a per-browser `dev-xxxx`
// id instead, honoured ONLY outside production so it can never impersonate a real account there.
export function devIdentity(options: { devId?: unknown; username?: unknown } | undefined): Identity | null {
  if (process.env.NODE_ENV === "production") return null;
  const id = options?.devId;
  if (typeof id !== "string" || !DEV_ID_PATTERN.test(id)) return null;
  const name = typeof options?.username === "string" ? options.username.slice(0, NAME_MAX) : "";
  return { userId: id, username: name || "Dev", pfp: "" };
}

// Test-only: swap fetch.
export function __setFetchForTest(f: typeof fetch | null): void {
  fetcher = f ?? fetch;
}
