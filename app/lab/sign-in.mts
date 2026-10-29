// Signs a dev or test instance in to your account with no one at it:
// a headless host's or a test install's `login`, or a dev window's
// sign-in with a code, each of which shows a link to Clerk's page and
// a code to approve there. This approves it, in a headless Chrome
// signed in as you for the moment it takes.
//
// That browser's sign-in is minted from a refresh token this keeps for
// the dev Clerk instance (.env.local's), outside the repo and readable
// by you alone: the hub turns its access token into a one-time Clerk
// sign-in (the sign-in token a window's code sign-in redeems), which
// the browser redeems. You approve that token once, on the first run,
// which shows its own link and code and waits. Clerk turns each
// refresh token over as it is used, so one run at a time does it.
//
// Run: pnpm sign-in <link>          approve the code behind a link
//      pnpm sign-in <command...>    run a command that signs in, and
//                                   approve the link it prints
import { spawn } from "node:child_process";
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
import { chromium } from "playwright-core";
import { createAccountService } from "../shared/account/service.ts";

const appDir = join(import.meta.dirname, "..");
const env = parseEnv(readFileSync(join(appDir, ".env.local"), "utf8"));
const publishableKey = env["SM_ACCOUNT_CLERK_PUBLISHABLE_KEY"] ?? "";
const clientId = env["SM_ACCOUNT_CLERK_OAUTH_CLIENT_ID"] ?? "";
const hubUrl = env["SM_DEVICE_HUB_URL"] ?? "";
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

const LINK = /https:\/\/\S+\?user_code=[A-Z0-9-]+/;
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

async function approve(link: string): Promise<void> {
  const ticket = await createAccountService({ baseUrl: hubUrl }).signInToken(
    await accessToken(),
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const clerkReady = () =>
      page.waitForFunction(() => window.Clerk?.loaded === true, null, {
        timeout: 60_000,
      });
    await page.goto(link);
    await clerkReady();
    await page.evaluate(async (redeem) => {
      const clerk = window.Clerk;
      if (clerk === undefined) throw new Error("no Clerk on the page");
      const attempt = await clerk.client.signIn.create({
        strategy: "ticket",
        ticket: redeem,
      });
      await clerk.setActive({ session: attempt.createdSessionId });
    }, ticket);
    await page.goto(link);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByText("Device approved").waitFor({ timeout: 30_000 });
    // The session lived for this approval alone.
    await clerkReady();
    await page.evaluate(() => window.Clerk?.signOut());
  } finally {
    await browser.close();
  }
  console.error(`[sign-in] approved ${link}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: pnpm sign-in <link> | <command...>");
  process.exit(2);
}
if (args.length === 1 && LINK.test(args[0] ?? "")) {
  await approve(args[0] ?? "");
} else {
  const [command = "", ...rest] = args;
  const child = spawn(command, rest, { stdio: ["inherit", "pipe", "pipe"] });
  let approving: Promise<void> | null = null;
  const watch = (into: NodeJS.WriteStream) => (chunk: Buffer) => {
    into.write(chunk);
    const link = LINK.exec(chunk.toString())?.[0];
    if (link !== undefined && approving === null) approving = approve(link);
  };
  child.stdout.on("data", watch(process.stdout));
  child.stderr.on("data", watch(process.stderr));
  const code = await new Promise<number>((done) =>
    child.on("close", (exit) => done(exit ?? 1)),
  );
  await approving;
  process.exit(code);
}
