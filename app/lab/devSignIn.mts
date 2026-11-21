// A one-time Clerk sign-in for the dev account, with no one at it: an
// access token from a refresh token kept for the dev Clerk instance
// (.env.local's), outside the repo and readable by you alone, which the
// account service (Colibrii) trades for a sign-in token a page redeems.
// You approve that refresh token once, on the first run, which shows
// its own link and code and waits. Clerk turns each refresh token over
// as it is used, so one run at a time does it (a lock beside it).
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import * as Colibrii from "@colibrii/sdk";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const appDir = join(import.meta.dirname, "..");
const env = parseEnv(readFileSync(join(appDir, ".env.local"), "utf8"));
const publishableKey = env["SM_ACCOUNT_CLERK_PUBLISHABLE_KEY"] ?? "";
const clientId = env["SM_ACCOUNT_CLERK_OAUTH_CLIENT_ID"] ?? "";
const hubUrl = env["SM_DEVICE_HUB_URL"] ?? "";
const hubApp = env["SM_DEVICE_HUB_APP"] ?? "shigomori-dev";
if (publishableKey === "" || clientId === "" || hubUrl === "") {
  throw new Error(
    ".env.local names no dev Clerk instance, OAuth client and hub to sign in with.",
  );
}
// The key's second half is the instance's Frontend API host, base64'd
// and ended with a `$`.
const clerkHost = Buffer.from(publishableKey.split("_")[2] ?? "", "base64")
  .toString()
  .replace(/\$$/, "");

const storeDir = join(
  process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"),
  "shigomori-dev-sign-in",
);
const storePath = join(storeDir, `${clerkHost}.json`);
const lockPath = join(storeDir, "lock");

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function postForm(url: string, body: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

const endpoints = async () => {
  const response = await fetch(
    `https://${clerkHost}/.well-known/openid-configuration`,
  );
  const discovery = (await response.json()) as Record<string, string>;
  return {
    device: discovery["device_authorization_endpoint"] ?? "",
    token: discovery["token_endpoint"] ?? "",
  };
};

// The person approves this script's own code, once.
async function firstGrant(token: string, device: string) {
  const code = await postForm(device, {
    client_id: clientId,
    scope: "offline_access",
  });
  console.error(
    `[sign-in] To let the dev tools sign instances in for you, open ${String(code["verification_uri_complete"] ?? code["verification_uri"])} and check it shows ${String(code["user_code"])}. Waiting…`,
  );
  let interval = Number(code["interval"] ?? 5);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polled at Clerk's pace
    await sleep(interval * 1000);
    // oxlint-disable-next-line no-await-in-loop -- one ask per turn
    const answer = await postForm(token, {
      grant_type: DEVICE_GRANT,
      device_code: String(code["device_code"]),
      client_id: clientId,
    });
    if (answer["error"] === "authorization_pending") continue;
    if (answer["error"] === "slow_down") {
      interval += 5;
      continue;
    }
    if (answer["error"] !== undefined) {
      throw new Error(`Clerk refused the sign-in: ${String(answer["error"])}`);
    }
    return answer;
  }
}

// The store turned over to its next refresh token, and the access
// token that came with it, one run at a time.
async function accessToken(): Promise<string> {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      // A run that died holding it let go of it long ago.
      if (Date.now() - statSync(lockPath).mtimeMs > 120_000) {
        rmSync(lockPath, { recursive: true, force: true });
      }
      // oxlint-disable-next-line no-await-in-loop -- waiting its turn
      await sleep(250);
    }
  }
  try {
    const { device, token } = await endpoints();
    let saved: Record<string, unknown> | null = null;
    try {
      saved = JSON.parse(readFileSync(storePath, "utf8"));
    } catch {
      // None yet.
    }
    let tokens =
      saved === null
        ? null
        : await postForm(token, {
            grant_type: "refresh_token",
            refresh_token: String(saved["refresh_token"]),
            client_id: clientId,
          });
    if (tokens === null || tokens["error"] !== undefined) {
      tokens = await firstGrant(token, device);
    }
    writeFileSync(storePath, JSON.stringify(tokens), { mode: 0o600 });
    return String(tokens["access_token"]);
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export const devSignInToken = async (): Promise<string> =>
  Effect.runPromise(
    Colibrii.signInToken({
      hub: hubUrl,
      app: hubApp,
      accessToken: await accessToken(),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
