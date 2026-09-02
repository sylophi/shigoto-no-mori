// Deployment entry: the worker with the real Clerk verifier, plus the
// Durable Object class wrangler binds as DEVICE_HUB.
import { verifyToken } from "@clerk/backend";
import { createWorker } from "./worker.ts";
import type { Env } from "./env.ts";

export { DeviceHub } from "./hubObject.ts";

// The enroll bearer is a Clerk session token: both clients render
// Clerk's embedded sign-in and mint the token off the live session
// (renderer/components/account/ClerkAccountSync.tsx), so verifyToken's
// default session-JWT verification applies, against the instance's
// JWKS which the secret key fetches from Clerk's Backend API (one
// outbound call per cold isolate, cached after), so the first enroll
// on a fresh isolate depends on api.clerk.com reachability. `sub` is
// the Clerk user id, so D1 rows and DO names key on it as the account
// id. Any verification failure (expired, foreign instance, malformed)
// collapses to null, which the worker turns into a 401.
async function verifyLogin(
  token: string,
  env: Env,
): Promise<{ accountId: string } | null> {
  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    const sub = payload.sub ?? "";
    return sub.length > 0 ? { accountId: sub } : null;
  } catch {
    return null;
  }
}

export default createWorker({ verifyLogin });
