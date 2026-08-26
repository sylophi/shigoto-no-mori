// Deployment entry: the worker with the real Clerk verifier, plus the
// Durable Object class wrangler binds as ACCOUNT_RELAY.
import { verifyToken } from "@clerk/backend";
import { createWorker } from "./worker.ts";
import type { Env } from "./env.ts";

export { AccountRelay } from "./relayObject.ts";

// Clerk owns identity: a valid session token's `sub` claim is the
// account id everything else (D1 rows, DO names) keys on. Any
// verification failure collapses to null, the worker turns that into
// a 401.
async function verifyLogin(
  token: string,
  env: Env,
): Promise<{ accountId: string } | null> {
  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    return typeof payload.sub === "string" && payload.sub.length > 0
      ? { accountId: payload.sub }
      : null;
  } catch {
    return null;
  }
}

export default createWorker({ verifyLogin });
