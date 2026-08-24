// The OAuth authorization-code-to-token exchange (RFC 6749 section 4.1.3
// with the PKCE code_verifier). Pure: the fetch implementation is
// injected so the account check script drives it with a stub and no
// network. The returned access_token is forwarded opaquely as the enroll
// bearer, the Worker is what verifies it.
import type { AccountServiceConfig } from "./serviceConfig";

// The subset of the token response this app reads. A compliant provider
// returns access_token on success. Everything else (refresh_token,
// expires_in, id_token) is ignored here because the credential the app
// keeps is the relay device credential, not the OAuth token.
type TokenResponseShape = { access_token?: unknown };

export type ExchangeParams = {
  code: string;
  verifier: string;
  redirectUri: string;
  // Injected so tests avoid the network. Defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

// POSTs the form-encoded grant to the token endpoint and returns the
// access_token string. Throws a clear Error on a non-2xx response or a
// response missing the token, so the login flow can surface a single
// failure reason to the user.
export async function exchangeCodeForToken(
  config: AccountServiceConfig,
  params: ExchangeParams,
): Promise<string> {
  const doFetch = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
  });
  const response = await doFetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await safeText(response);
    throw new Error(
      `token exchange failed with status ${response.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  const json = (await response.json()) as TokenResponseShape;
  const token = json.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("token response did not include an access_token");
  }
  return token;
}

// Best-effort read of an error body for the thrown message. A body that
// cannot be read must not mask the real status code.
async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}
