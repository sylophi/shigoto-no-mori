// Signs a dev or test instance in to your account with no one at it:
// a headless host's or a test install's `login`, or a dev window's
// sign-in with a code, each of which shows a link to Clerk's page and
// a code to approve there. This approves it, in a headless Chrome
// signed in as you for the moment it takes.
//
// That browser's sign-in is a one-time Clerk sign-in for you
// (devSignIn.mts), the same sign-in token a window's code sign-in
// redeems.
//
// Run: pnpm sign-in <link>          approve the code behind a link
//      pnpm sign-in <command...>    run a command that signs in, and
//                                   approve the link it prints
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { devSignInToken } from "./devSignIn.mts";

const LINK = /https:\/\/\S+\?user_code=[A-Z0-9-]+/;

async function approve(link: string): Promise<void> {
  const ticket = await devSignInToken();
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
