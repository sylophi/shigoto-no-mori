// The sign-in orchestration: RFC 8252 loopback authorization code flow
// with PKCE, then relay enrollment, then credential storage. Pure aside
// from node:http (the loopback server): the browser opener, the account
// service, the store and fetch are all injected, so the account check
// script runs the whole flow against stubs with no electron, no real
// browser and no network.
import { createServer, type Server } from "node:http";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  generateState,
  parseRedirectQuery,
} from "@shared/account/pkce";
import type { AccountServiceConfig } from "@shared/account/serviceConfig";
import { deriveAccountId } from "@shared/account/token";
import { exchangeCodeForToken } from "@shared/account/tokenExchange";
import type { AccountService } from "@shared/account/service";
import type { AccountStore } from "@shared/account/credentialStore";

// Re-exported so the account check script and the handler module keep
// one import site for the login-flow surface.
export { deriveAccountId };

// How long the flow waits for the browser redirect before giving up. A
// user who abandons the browser tab must not leave a loopback server
// listening forever.
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

// The page the browser lands on after the redirect. Deliberately tiny and
// self-contained, no external assets, since it renders inside whatever
// browser the OS opened.
const DONE_HTML =
  "<!doctype html><html><head><meta charset=utf-8>" +
  '<title>Signed in</title></head><body style="font-family:system-ui;' +
  'padding:3rem;text-align:center"><h1>You are signed in.</h1>' +
  "<p>You can close this tab and return to Shigoto no Mori.</p>" +
  "</body></html>";

export type LoginDeps = {
  config: AccountServiceConfig;
  deviceId: string;
  deviceName: string;
  platform: string;
  // Injected so the flow is testable and electron-free. The real caller
  // passes shell.openExternal.
  openBrowser: (url: string) => void | Promise<void>;
  service: AccountService;
  store: AccountStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// The stored result the renderer surfaces as post-sign-in status.
export type LoginResult = { accountId: string; deviceName: string };

export async function runLoginFlow(deps: LoginDeps): Promise<LoginResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The S256 challenge is computed through the async WebCrypto digest, so
  // the pair is awaited before the loopback flow starts.
  const { verifier, challenge } = await generatePkcePair();
  const state = generateState();

  return new Promise<LoginResult>((resolve, reject) => {
    let settled = false;
    // Redemption latch for the callback. The authorization code is
    // single use, so only the FIRST valid redirect may run the
    // exchange. Separate from `settled` because the exchange and the
    // enroll take real time: a replay arriving in that window would
    // otherwise re-enter completeExchange, the provider would refuse
    // the burnt code (invalid_grant), abort() would reject the flow,
    // and the first exchange's success would then hit the settled
    // guard and silently drop the credential it obtained.
    let redeemed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let server: Server | null = null;
    // Only known once the OS assigns the ephemeral port, so the authorize
    // URL and the token exchange both read it after listen binds.
    let redirectUri = "";

    // One-shot cleanup: close the loopback server and clear the timeout
    // so neither outlives the flow, whichever branch settled it.
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (server) {
        server.close();
        server = null;
      }
    };

    const finish = (result: LoginResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const abort = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    server = createServer((req, res) => {
      // Answer a bad redirect with the failure page and abort the flow.
      // Both 400 branches are byte-identical except this message.
      const fail400 = (message: string): void => {
        res.statusCode = 400;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<p>Sign in failed. You can close this tab.</p>");
        abort(new Error(message));
      };
      // The browser can hit favicon or other paths. Only the callback
      // path carries the code, everything else gets a 404 and is ignored.
      const rawUrl = req.url ?? "";
      if (!rawUrl.startsWith("/callback")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const parsed = parseRedirectQuery(rawUrl);
      if ("error" in parsed) {
        fail400(`authorization failed: ${parsed.error}`);
        return;
      }
      // A state mismatch means the redirect is not the one this flow
      // started (CSRF or a stale tab). Reject rather than exchange.
      if (parsed.state !== state) {
        fail400("authorization state mismatch");
        return;
      }
      // A second redirect with the correct state (a tab reload, a
      // prefetch, a browser session restore) lands here after the first
      // already started the exchange. Answer it like any stray path and
      // leave the in-flight or completed sign-in untouched.
      if (redeemed) {
        res.statusCode = 404;
        res.end();
        return;
      }
      redeemed = true;
      // Answer the browser first so the user sees the done page even if
      // the exchange or enroll below is slow, then run the rest.
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(DONE_HTML);
      void completeExchange(parsed.code);
    });

    const completeExchange = async (code: string): Promise<void> => {
      // The valid redirect has arrived, so we are no longer waiting on
      // the user. Clear the timeout before the exchange begins, otherwise
      // a timeout firing mid-enroll would reject the promise while the
      // store.write below still persisted a credential.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const token = await exchangeCodeForToken(deps.config, {
          code,
          verifier,
          redirectUri,
          fetchImpl: deps.fetchImpl,
        });
        const enrollment = await deps.service.enroll(token, {
          deviceId: deps.deviceId,
          name: deps.deviceName,
          platform: deps.platform,
        });
        const accountId = deriveAccountId(token);
        // If the flow already settled (a server error, a late abort), do
        // not persist. The invariant is that the credential reaches disk
        // only on the success path of a not-yet-settled flow.
        if (settled) return;
        deps.store.write({
          credential: enrollment.credential,
          accountId,
          deviceName: deps.deviceName,
        });
        finish({ accountId, deviceName: deps.deviceName });
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    };

    server.on("error", (error) => abort(error));

    // Bind to an ephemeral loopback port. The redirect URI is only known
    // once the OS assigns the port, so the authorize URL is built inside
    // the listen callback.
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        abort(new Error("loopback server did not bind a port"));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const authorizeUrl = buildAuthorizeUrl(deps.config, {
        redirectUri,
        challenge,
        state,
      });
      // Start the timeout only once we are actually waiting on the user.
      timer = setTimeout(() => {
        abort(new Error("timed out waiting for the sign-in redirect"));
      }, timeoutMs);
      // openBrowser may reject (no browser, denied). That is a real
      // failure of the flow, not a background best-effort.
      Promise.resolve(deps.openBrowser(authorizeUrl)).catch(
        (error: unknown) => {
          abort(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  });
}
