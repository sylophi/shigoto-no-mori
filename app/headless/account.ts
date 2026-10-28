// This machine's account, which the headless host keeps itself, having
// no shell around it to keep it: the credential and device key in
// userData's account.json, as plaintext in a file only its owner can
// read (main/electron/account.ts says why), handed to the host as the
// Electron shell hands them (applyAccount). Signing in is the
// terminal's (`sm login`, the login contract): Clerk's device grant,
// whose access token enrolls this device once and is dropped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  clerkFrontendHost,
  isConfigured,
  mergeServiceEnv,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import {
  loginContract,
  type LoginCode,
  type LoginStatus,
} from "@shigomori/contracts/modules/login";
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { current as currentPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { applyAccount } from "@host/process/handlers";
import type { HostServices } from "@host/process/services";
import { registerLoopbackContract } from "@host/process/wires";
import { createAccountStore } from "@shared/account/credentialFile";
import { defaultDesktopDeviceName } from "@shared/account/defaultDeviceName";
import {
  enrollDevice,
  retryParkedRevoke,
  signOutDevice,
} from "@shared/account/enroll";
import { createAccountService } from "@shared/account/service";
import type { HostFacts } from "@shared/hostFacts";
import type { HandlerContext } from "@shared/ipc/transport";
import { log } from "@shared/log";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// How long one call to Clerk may take.
const CLERK_TIMEOUT_MS = 15_000;

// Lowest to highest, as the desktop's (main/electron/account.ts): a dev
// run's .env.local in the checkout it runs from, the values baked into
// the bundle, the real environment. A packaged host reads no file.
function serviceConfig(facts: HostFacts): AccountServiceConfig {
  let fileEnv: Record<string, string | undefined> = {};
  if (!facts.packaged) {
    try {
      fileEnv = parseEnv(
        readFileSync(join(process.cwd(), ".env.local"), "utf8"),
      );
    } catch {
      // No dev file. Baked and environment values are the only sources.
    }
  }
  return resolveServiceConfig(
    mergeServiceEnv(fileEnv, __SM_ACCOUNT_BAKED_ENV__, process.env),
  );
}

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

// A form POST to one of Clerk's OAuth endpoints, its JSON as it came.
async function postForm(
  url: string,
  form: Record<string, string>,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(form),
    signal: AbortSignal.any([signal, AbortSignal.timeout(CLERK_TIMEOUT_MS)]),
  });
  return { ok: response.ok, body: await response.json() };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const call = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

// Made before the host starts, since the loopback takes its contracts
// as it starts. The device id comes once the host is up (boot), and a
// call before then waits for it.
export function headlessAccount(facts: HostFacts) {
  const config = serviceConfig(facts);
  let deviceIdIs!: (deviceId: string) => void;
  const deviceIdOf = new Promise<string>((resolve) => {
    deviceIdIs = resolve;
  });
  const service = createAccountService({ baseUrl: config.hubUrl });
  const store = createAccountStore({
    filePath: join(facts.userDataPath, "account.json"),
    cipher: {
      available: false,
      encrypt: (plaintext) => plaintext,
      decrypt: (payload) => payload,
    },
  });
  // The account's changes, one at a time and each whole, the host told
  // of it included.
  const transitions = Semaphore.makeUnsafe(1);
  const inTurn = (change: () => Promise<void>) =>
    Effect.runPromise(
      transitions.withPermit(
        Effect.promise(async () => {
          await change();
          await applyAccount(factsForHost());
        }),
      ),
    );

  function factsForHost(): AccountFacts | null {
    const record = store.read();
    if (record === null || !isConfigured(config)) return null;
    return {
      hubUrl: config.hubUrl,
      accountId: record.accountId,
      credential: record.credential,
      deviceKey: record.deviceKey,
      webOrigin: config.webOrigin,
      acceptsCommands: record.acceptsCommands === true,
    };
  }

  // Clerk's OAuth endpoints, as the instance advertises them. It
  // advertises the device one only once the grant is on.
  async function clerkEndpoints(signal: AbortSignal) {
    const host = clerkFrontendHost(config.publishableKey);
    if (!isConfigured(config) || host === null) {
      throw new Error("This build has no account service to sign in to.");
    }
    if (config.oauthClientId === "") {
      throw new Error("This build can't sign in from the terminal.");
    }
    const response = await fetch(
      `https://${host}/.well-known/openid-configuration`,
      {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(CLERK_TIMEOUT_MS),
        ]),
      },
    );
    const discovery = Schema.decodeUnknownSync(DiscoverySchema)(
      await response.json(),
    );
    if (discovery.device_authorization_endpoint === undefined) {
      throw new Error("Signing in from the terminal isn't turned on.");
    }
    return {
      device: discovery.device_authorization_endpoint,
      token: discovery.token_endpoint,
    };
  }

  const status = async (): Promise<LoginStatus> => {
    const record = store.read();
    return {
      signedIn: record !== null,
      deviceName:
        record?.deviceName ??
        store.rememberedDeviceName() ??
        (await defaultDesktopDeviceName()).name,
    };
  };

  const start = async (signal: AbortSignal): Promise<LoginCode> => {
    const record = store.read();
    if (record !== null) {
      throw new Error(
        `This machine is signed in already, as ${record.deviceName}. Sign out first.`,
      );
    }
    const endpoints = await clerkEndpoints(signal);
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
  };

  // Asks Clerk at the pace it set until the person answers, then
  // enrolls under the access token. A call that fails on the way (the
  // network away a moment) is asked again at the next turn. The caller
  // gone, the asking stops.
  const finish = async (
    code: LoginCode,
    signal: AbortSignal,
  ): Promise<LoginStatus> => {
    const endpoints = await clerkEndpoints(signal);
    const deadline = Date.now() + code.expiresIn * 1000;
    const ask = async (interval: number): Promise<LoginStatus> => {
      await sleep(interval * 1000, signal);
      if (Date.now() > deadline) throw expired();
      const answer = await postForm(
        endpoints.token,
        {
          grant_type: DEVICE_GRANT,
          device_code: code.deviceCode,
          client_id: config.oauthClientId,
        },
        signal,
      ).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return null;
      });
      if (answer === null) return ask(interval);
      if (answer.ok) {
        const tokens = Schema.decodeUnknownSync(TokensSchema)(answer.body);
        await signIn(tokens.access_token);
        return status();
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
  };

  const signIn = async (token: string) => {
    const name = await defaultDesktopDeviceName();
    const deviceId = await deviceIdOf;
    await inTurn(() =>
      enrollDevice(
        {
          config,
          service,
          store,
          deviceId,
          fallbackDeviceName: name.name,
          platform: currentPlatform(),
          detectedIcon: "server",
        },
        token,
      ),
    );
  };

  // The revoke is best effort: offline, it is parked for the next start
  // (retryParkedRevoke), and this device signs out here anyway.
  const signOut = async () => {
    const deviceId = await deviceIdOf;
    await inTurn(() =>
      signOutDevice({
        config,
        service,
        store,
        deviceId,
        onRevokeFailure: (error) =>
          log.warn(
            `[account] the hub didn't take this device's revoke, so it's kept for later: ${errorMessageOf(error)}`,
          ),
      }),
    );
  };

  const login: EffectHandlers<
    typeof loginContract,
    HandlerContext,
    HostServices
  > = {
    status: () => call(status),
    start: () => call(start),
    finish: (code) => call((signal) => finish(code, signal)),
    signOut: () => call(signOut),
  };
  registerLoopbackContract(loginContract, login);

  return {
    // The account as this start finds it, and a revoke a sign-out
    // couldn't deliver, delivered now.
    boot: async (deviceId: string) => {
      deviceIdIs(deviceId);
      await applyAccount(factsForHost());
      const parked = await retryParkedRevoke({
        config,
        service,
        store,
        deviceId,
      });
      if (parked.kind === "failed") {
        log.warn(
          `[account] a revoke kept from a sign-out still didn't land: ${errorMessageOf(parked.error)}`,
        );
      }
    },
    // A nuke's sign-out, as the desktop's (main/electron/account.ts):
    // why the revoke didn't land when it stays parked, else null.
    signOutForNuke: async (): Promise<string | null> => {
      const deviceId = await deviceIdOf;
      let failure = "";
      await inTurn(async () => {
        const signedIn = store.read() !== null;
        await signOutDevice({
          config,
          service,
          store,
          deviceId,
          onRevokeFailure: (error) => {
            failure = errorMessageOf(error);
          },
        });
        if (!signedIn) {
          const parked = await retryParkedRevoke({
            config,
            service,
            store,
            deviceId,
          });
          if (parked.kind === "failed") failure = errorMessageOf(parked.error);
        }
      });
      return store.readParked() === null ? null : failure;
    },
  };
}

const expired = () =>
  new Error("The code expired before it was approved. Sign in again.");

function oauthWords(body: unknown): string {
  return Option.match(decodeOAuthError(body), {
    onNone: () => "an answer it didn't explain",
    onSome: (error) => error.error_description ?? error.error,
  });
}
