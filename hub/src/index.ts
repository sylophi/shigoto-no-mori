// Deployment entry: the worker with the real Clerk verifier, plus the
// Durable Object class wrangler binds as DEVICE_HUB.
import { createClerkClient, verifyToken } from "@clerk/backend";
import { decodeJwt } from "@clerk/backend/jwt";
import { tokenRefused } from "./clerk.ts";
import { createWorker } from "./worker.ts";
import type { Env } from "./env.ts";

export { DeviceHub } from "./hubObject.ts";

const OAUTH_JWT_TYPES = ["at+jwt", "application/at+jwt"];

// The enroll bearer is a Clerk session token from the clients that
// render Clerk's embedded sign-in, which mint it off the live session
// (renderer/components/account/ClerkAccountSync.tsx), or, from a
// machine with no browser (`sm login` on a server), the OAuth access
// token Clerk's device grant issued it. Both are JWTs, verified
// against the instance's JWKS, which the secret key fetches from
// Clerk's Backend API (one outbound call per cold isolate, cached
// after), so the first enroll on a fresh isolate depends on
// api.clerk.com reachability. `sub` is the Clerk user id, so D1 rows
// and DO names key on it as the account id. Only the app's own OAuth
// application counts (CLERK_OAUTH_CLIENT_ID): a token Clerk issued to
// any other application on the instance enrolls nothing. A token that
// does not verify (expired, foreign instance, malformed) is null, which
// the worker refuses. A check that could not run (the JWKS unreachable,
// the key misconfigured) throws, which it answers as unavailable.
async function verifyLogin(
  token: string,
  env: Env,
): Promise<{ accountId: string } | null> {
  const oauth = isOAuthJwt(token);
  if (oauth && env.CLERK_OAUTH_CLIENT_ID === undefined) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      ...(oauth ? { headerType: OAUTH_JWT_TYPES } : {}),
    });
    if (oauth && payload["client_id"] !== env.CLERK_OAUTH_CLIENT_ID) {
      return null;
    }
    const sub = payload.sub ?? "";
    return sub.length > 0 ? { accountId: sub } : null;
  } catch (error) {
    if (tokenRefused(error)) return null;
    throw error;
  }
}

function isOAuthJwt(token: string): boolean {
  try {
    const type = decodeJwt(token).header.typ;
    return type !== undefined && OAUTH_JWT_TYPES.includes(type);
  } catch {
    return false;
  }
}

// Redeemed within minutes, once, by the window that asked.
const SIGN_IN_TOKEN_SECONDS = 300;

async function mintSignInToken(accountId: string, env: Env): Promise<string> {
  const { token } = await createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
  }).signInTokens.createSignInToken({
    userId: accountId,
    expiresInSeconds: SIGN_IN_TOKEN_SECONDS,
  });
  return token;
}

export default createWorker({ verifyLogin, mintSignInToken });
