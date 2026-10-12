// A packaged build's relaunch must leave a live window: opens the app
// with a debugging port, asks its window to relaunch (what the
// migration, a data-folder move and a nuke end with), waits past the
// second or so after which macOS terminates a quit app's subordinate
// processes (main/electron/relaunch.ts), and asks the new window
// something only a live renderer answers. Fails, naming what it saw,
// when the new instance never came or lost a child process.
//
// Run: node lab/relaunch.mts "<path to the .app>" [--port 9341]
// A test build (SM_FLAVOR=test pnpm package) runs beside the installed
// app. It quits the app at the end.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findPageApi } from "./reliability/pageApi.mts";

const bundle = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 9341;
if (bundle === undefined || !existsSync(bundle)) {
  console.error('Usage: node lab/relaunch.mts "<path to the .app>" [--port n]');
  process.exit(2);
}
const appName = basename(bundle, ".app");
const executable = join(bundle, "Contents", "MacOS", appName);
const mainLog = join(homedir(), "Library", "Logs", appName, "main.log");

const pidOfApp = (): number | null => {
  try {
    const pattern = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const out = execFileSync("pgrep", ["-f", `^${pattern} `], {
      encoding: "utf8",
    });
    return Number(out.trim().split("\n")[0]) || null;
  } catch {
    return null;
  }
};

// Polls `probe` every 200 ms until it answers something, for `ms`.
const until = async <A,>(
  what: string,
  ms: number,
  probe: () => Promise<A | null>,
  end = Date.now() + ms,
): Promise<A> => {
  const value = await probe().catch(() => null);
  if (value !== null) return value;
  if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  await sleep(200);
  return until(what, ms, probe, end);
};

// Evaluates in the app's window over its debugging port.
const evaluate = async (expression: string) => {
  const list = (await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = list.find((t) => t.type === "page" && t.url.includes("://app/"));
  if (page === undefined) return null;
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer")), 3000);
      socket.addEventListener("message", (event) => {
        clearTimeout(timer);
        const reply = JSON.parse(String(event.data));
        resolve(reply.result?.result?.value ?? null);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
};

const killedLines = () =>
  existsSync(mainLog)
    ? readFileSync(mainLog, "utf8")
        .split("\n")
        .filter((line) => line.includes("reason=killed"))
    : [];

if (pidOfApp() !== null) {
  console.error(`${appName} is running. Quit it first.`);
  process.exit(2);
}
execFileSync("open", [
  "-n",
  "-a",
  bundle,
  "--args",
  `--remote-debugging-port=${port}`,
  // Started for the lab, so the window hands over its api.
  "--sm-lab",
]);
// The window's api (findPageApi), as an expression.
const api = `(${findPageApi})()`;
const first = await until("the app", 60_000, async () =>
  (await evaluate(`typeof ${api}`)) === "object" ? pidOfApp() : null,
);
const killedBefore = killedLines().length;
const asked = Date.now();
await evaluate(`${api}.window.relaunch()`).catch(() => null);
const second = await until("the relaunched app", 60_000, async () => {
  const pid = pidOfApp();
  return pid !== null && pid !== first ? pid : null;
});
const windowBack = await until("its window", 30_000, async () =>
  (await evaluate(`typeof ${api}`)) === "object" ? Date.now() - asked : null,
).catch(() => null);
// Past the subordinate termination, which lands a second or so after
// the old instance is gone.
await sleep(5000);
const answer = await evaluate(
  `${api}.account.status().then(() => 'live')`,
).catch((error) => `no answer: ${error}`);
const killed = killedLines().slice(killedBefore);
// A window whose renderer was killed ignores a quit.
const last = pidOfApp();
if (last !== null) process.kill(last, "SIGKILL");

console.log(
  `relaunched as ${second} (was ${first}), window ${windowBack === null ? "never answered" : `back in ${windowBack} ms`}`,
);
console.log(`5 s later the window says: ${answer}`);
for (const line of killed) console.log(`  ${line}`);
if (answer !== "live" || killed.length > 0) {
  console.error("FAIL: the relaunched app lost its window or a child process");
  process.exit(1);
}
console.log("ok: the relaunched app kept its window");
