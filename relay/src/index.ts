// Deployment entry: the worker with the real Clerk verifier, plus the
// Durable Object class wrangler binds as ACCOUNT_RELAY.
//
// verifyMachineAuthToken lives under @clerk/backend/internal in the
// pinned 3.16.x. The root export only carries verifyToken.
import { verifyMachineAuthToken } from "@clerk/backend/internal";
import { createWorker } from "./worker.ts";
import type { Env } from "./env.ts";

export { AccountRelay } from "./relayObject.ts";

// Clerk owns identity, but the enroll bearer is NOT a session token:
// both clients (main/account/login.ts, web/account/login.ts) run
// authorization-code + PKCE against a Clerk OAuth application, and
// shared/account/tokenExchange.ts forwards the resulting access token
// opaquely. Clerk issues those in two formats - opaque `oat_...`, or
// a JWT with header `typ: "at+jwt"` - and `verifyToken` rejects both
// (it decodes only JWTs and demands `typ: "JWT"`), so "fixing" this
// back to verifyToken breaks enrollment 100% of the time.
// verifyMachineAuthToken detects the format itself: local JWKS
// verification for the JWT form, a Backend API call for the opaque
// form. It also accepts M2M tokens (mt_) and API keys (ak_), neither
// of which may ever enroll a device, hence the tokenType gate.
// `data.subject` is the Clerk user id, the same value a session
// token's `sub` carried, so D1 rows and DO names key on the same
// account id as before. Any verification failure collapses to null,
// the worker turns that into a 401.
async function verifyLogin(
  token: string,
  env: Env,
): Promise<{ accountId: string } | null> {
  try {
    const { data, tokenType, errors } = await verifyMachineAuthToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    if (errors || tokenType !== "oauth_token") return null;
    if (data.revoked || data.expired) return null;
    return data.subject.length > 0 ? { accountId: data.subject } : null;
  } catch {
    return null;
  }
}

export default createWorker({ verifyLogin });
