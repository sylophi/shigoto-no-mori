// The browser sign-in orchestration (v2 step 5, slice B): the same
// authorization-code-with-PKCE flow the desktop runs (main/account/
// login.ts), with the loopback server replaced by a full-page redirect.
// The page navigates to the provider, so the verifier and state survive
// the round trip in sessionStorage instead of process memory, and the
// callback route completes the exchange, enrolls this browser as a
// relay device (platform "web") and stores the credential. Pure aside
// from the injected seams (storage, service, fetch), so the headless
// bridge check drives the whole flow with stubs and no browser.
import {
  buildAuthorizeUrl,
  generatePkcePair,
  generateState,
  parseRedirectQuery,
} from "@shared/account/pkce";
import type { AccountService } from "@shared/account/service";
import {
  isConfigured,
  type AccountServiceConfig,
} from "@shared/account/serviceConfig";
import { deriveAccountId } from "@shared/account/token";
import { exchangeCodeForToken } from "@shared/account/tokenExchange";
import type { AccountStore } from "@shared/account/credentialStore";
import {
  readKey,
  removeKey,
  writeKey,
  type KeyValueStorage,
} from "../lib/kvStorage";

// The platform label this client enrolls under. EnrollRequestSchema
// bounds platform as a free string (1..64), so "web" is a legal value
// the relay stores opaquely, sitting beside the desktop's os.platform()
// labels ("darwin", "win32", ...) in the device list.
export const WEB_PLATFORM = "web";

// The SPA route the provider redirects back to. The deploy config must
// rewrite it (and every other path) to index.html, and the OAuth
// application must register `<origin>/auth/callback` as an allowed
// redirect URI.
export const LOGIN_CALLBACK_PATH = "/auth/callback";

export function loginRedirectUri(origin: string): string {
  return `${origin}${LOGIN_CALLBACK_PATH}`;
}

// The half-open flow parked across the redirect. The verifier is the
// PKCE secret: sessionStorage scopes it to this tab and the browsing
// session, the narrowest storage that still survives the navigation.
const PENDING_KEY = "sm.web.loginPending";

type PendingLogin = { verifier: string; state: string };

function readPending(storage: KeyValueStorage): PendingLogin | null {
  const raw = readKey(storage, PENDING_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingLogin>;
    if (
      typeof parsed?.verifier === "string" &&
      typeof parsed?.state === "string"
    ) {
      return { verifier: parsed.verifier, state: parsed.state };
    }
  } catch {
    // Corrupt pending state reads as "no flow in progress".
  }
  return null;
}

export type BeginLoginDeps = {
  config: AccountServiceConfig;
  sessionStorage: KeyValueStorage;
  origin: string;
  // Injected so the flow is testable: the real caller passes
  // window.location.assign. The page unloads right after this fires.
  navigate: (url: string) => void;
};

// Starts the redirect flow: mint the PKCE pair and state, park them for
// the callback, and send the page to the provider. Throws before
// navigating when the build is unconfigured, so the caller can surface
// the "not configured" state instead of a dead redirect.
export async function beginLogin(deps: BeginLoginDeps): Promise<void> {
  if (!isConfigured(deps.config)) {
    throw new Error(
      "the relay account service is not configured on this build",
    );
  }
  const { verifier, challenge } = await generatePkcePair();
  const state = generateState();
  const pending: PendingLogin = { verifier, state };
  writeKey(deps.sessionStorage, PENDING_KEY, JSON.stringify(pending));
  deps.navigate(
    buildAuthorizeUrl(deps.config, {
      redirectUri: loginRedirectUri(deps.origin),
      challenge,
      state,
    }),
  );
}

export type CompleteLoginDeps = {
  config: AccountServiceConfig;
  sessionStorage: KeyValueStorage;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
};

// Completes the flow on the callback route: verify the returned state
// against the parked one, exchange the code, enroll this browser and
// persist the credential. The pending record is consumed up front so a
// reloaded callback page cannot re-run the exchange with a burnt code.
// The caller reads the outcome back out of the store (the bridge
// re-reads status after this resolves), so there is nothing to return.
export async function completeLogin(
  deps: CompleteLoginDeps,
  rawRedirectUrl: string,
): Promise<void> {
  const pending = readPending(deps.sessionStorage);
  removeKey(deps.sessionStorage, PENDING_KEY);
  if (pending === null) {
    throw new Error("no sign-in in progress, start again");
  }
  const parsed = parseRedirectQuery(rawRedirectUrl);
  if ("error" in parsed) {
    throw new Error(`authorization failed: ${parsed.error}`);
  }
  // A state mismatch means this redirect is not the flow this tab
  // started (CSRF or a stale tab). Reject rather than exchange.
  if (parsed.state !== pending.state) {
    throw new Error("authorization state mismatch");
  }
  const token = await exchangeCodeForToken(deps.config, {
    code: parsed.code,
    verifier: pending.verifier,
    redirectUri: loginRedirectUri(originOf(rawRedirectUrl)),
    fetchImpl: deps.fetchImpl,
  });
  const enrollment = await deps.service.enroll(token, {
    deviceId: deps.deviceId,
    name: deps.deviceName,
    platform: WEB_PLATFORM,
  });
  deps.store.write({
    credential: enrollment.credential,
    accountId: deriveAccountId(token),
    deviceName: deps.deviceName,
  });
}

// The token exchange must present the exact redirect_uri the authorize
// request carried. Both are derived from the callback URL's own origin,
// which is by construction the origin beginLogin ran on.
function originOf(rawUrl: string): string {
  return new URL(rawUrl).origin;
}

export type LogoutDeps = {
  config: AccountServiceConfig;
  service: AccountService;
  store: AccountStore;
  deviceId: string;
};

// Mirrors the desktop's sign-out semantics: best-effort revoke of THIS
// device on the relay first, then clear the stored credential. Any
// revoke failure (offline, relay down, non-2xx) is swallowed because
// local sign-out must always succeed.
export async function logout(deps: LogoutDeps): Promise<void> {
  const record = deps.store.read();
  if (record !== null && isConfigured(deps.config)) {
    try {
      await deps.service.revoke(record.credential, deps.deviceId);
    } catch {
      // Clearing locally regardless is the whole point.
    }
  }
  deps.store.clear();
}
