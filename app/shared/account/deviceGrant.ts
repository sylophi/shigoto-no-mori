// Clerk's device grant, the sign-in for a place with no browser of its
// own to sign in through: Clerk hands out a code, the person approves it
// on Clerk's page from any device, and the side that asked, asking Clerk
// at the pace it set, gets an OAuth access token for them. The headless
// host enrolls under it (`sm login`), and a window started for it
// (SHIGOMORI_CODE_SIGN_IN) trades it with the hub for a Clerk session
// (account:finishCodeSignIn).
import {
  clerkFrontendHost,
  isConfigured,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import type { LoginCode } from "@shigomori/contracts/modules/login";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// How long one call to Clerk may take.
const CLERK_TIMEOUT_MS = 15_000;

const DiscoverySchema = Schema.Struct({
  token_endpoint: Schema.String,
  device_authorization_endpoint: Schema.optional(Schema.String),
});

const DeviceCodeSchema = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Finite,
  interval: Schema.optional(Schema.Finite),
});

const TokensSchema = Schema.Struct({
  access_token: Schema.String,
});

const OAuthErrorSchema = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

const decodeOAuthError = Schema.decodeUnknownOption(OAuthErrorSchema);

const timed = (signal: AbortSignal | undefined) =>
  signal === undefined
    ? AbortSignal.timeout(CLERK_TIMEOUT_MS)
    : AbortSignal.any([signal, AbortSignal.timeout(CLERK_TIMEOUT_MS)]);

// A form POST to one of Clerk's OAuth endpoints, its JSON as it came.
async function postForm(
  url: string,
  form: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ readonly ok: boolean; readonly body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(form),
    signal: timed(signal),
  });
  return { ok: response.ok, body: await response.json() };
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

// Clerk's OAuth endpoints, as the instance advertises them. It
// advertises the device one only once the grant is on.
async function clerkEndpoints(
  config: AccountServiceConfig,
  signal: AbortSignal | undefined,
) {
  const host = clerkFrontendHost(config.publishableKey);
  if (!isConfigured(config) || host === null) {
    throw new Error("This build has no account service to sign in to.");
  }
  if (config.oauthClientId === "") {
    throw new Error("This build can't sign in with a code.");
  }
  const response = await fetch(
    `https://${host}/.well-known/openid-configuration`,
    { signal: timed(signal) },
  );
  const discovery = Schema.decodeUnknownSync(DiscoverySchema)(
    await response.json(),
  );
  if (discovery.device_authorization_endpoint === undefined) {
    throw new Error("Signing in with a code isn't turned on.");
  }
  return {
    device: discovery.device_authorization_endpoint,
    token: discovery.token_endpoint,
  };
}

export async function startDeviceGrant(
  config: AccountServiceConfig,
  signal?: AbortSignal,
): Promise<LoginCode> {
  const endpoints = await clerkEndpoints(config, signal);
  const { ok, body } = await postForm(
    endpoints.device,
    { client_id: config.oauthClientId },
    signal,
  );
  if (!ok) throw new Error(`Clerk refused the sign-in: ${oauthWords(body)}`);
  const code = Schema.decodeUnknownSync(DeviceCodeSchema)(body);
  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    ...(code.verification_uri_complete === undefined
      ? {}
      : { verificationUriComplete: code.verification_uri_complete }),
    deviceCode: code.device_code,
    interval: code.interval ?? 5,
    expiresIn: code.expires_in,
  };
}

// Asks Clerk at the pace it set until the person answers, then answers
// the access token. A call that fails on the way (the network away a
// moment) is asked again at the next turn. The caller gone (signal),
// the asking stops, else it stops with the code.
export async function awaitDeviceGrant(
  config: AccountServiceConfig,
  code: LoginCode,
  signal?: AbortSignal,
): Promise<string> {
  const endpoints = await clerkEndpoints(config, signal);
  const lapsed = AbortSignal.timeout(code.expiresIn * 1000);
  const ask = async (interval: number): Promise<string> => {
    await sleep(interval * 1000, signal);
    if (lapsed.aborted) throw expired();
    const answer = await postForm(
      endpoints.token,
      {
        grant_type: DEVICE_GRANT,
        device_code: code.deviceCode,
        client_id: config.oauthClientId,
      },
      signal,
    ).catch((error: unknown) => {
      if (signal?.aborted === true) throw error;
      return null;
    });
    if (answer === null) return ask(interval);
    if (answer.ok) {
      return Schema.decodeUnknownSync(TokensSchema)(answer.body).access_token;
    }
    const error = Option.getOrUndefined(decodeOAuthError(answer.body));
    switch (error?.error) {
      case "authorization_pending":
        return ask(interval);
      case "slow_down":
        return ask(interval + 5);
      case "access_denied":
        throw new Error("The sign-in was denied.");
      case "expired_token":
        throw expired();
      default:
        throw new Error(
          `Clerk refused the sign-in: ${oauthWords(answer.body)}`,
        );
    }
  };
  return ask(code.interval);
}

const expired = () =>
  new Error("The code expired before it was approved. Sign in again.");

function oauthWords(body: unknown): string {
  return Option.match(decodeOAuthError(body), {
    onNone: () => "an answer it didn't explain",
    onSome: (error) => error.error_description ?? error.error,
  });
}
