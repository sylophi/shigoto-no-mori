// The host on a machine with no windows: the host's run in this process,
// over a Shell of its own (shell.ts), served to the terminal on the
// loopback and to the account's other devices on the device link. A
// packaged one runs under the systemd user unit `sm service` installs,
// which starts it at boot and again whenever it exits but for a stop.
// A stop is a SIGTERM, and a Ctrl-C at a dev run's terminal a SIGINT:
// either is a quit.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HARNESSES } from "@shigomori/engine/agentHooks";
import { NUKE_EXIT } from "@shigomori/engine/footprint";
import { quit, runHost } from "@host/process/run";
import { log } from "@shared/log";
import { finishPendingNuke } from "@shared/nuke";
import { applyUserShellEnv } from "@shared/shellEnv";
import { takeUpdateEndpointOverrides } from "@shared/updater/endpoints";
import { headlessAccount } from "./account";
import { headlessFacts } from "./facts";
import { finishNuke, nuking, runNuke } from "./nuke";
import * as HeadlessShell from "./shell";

// One host per flavor on this machine: a database in its userData,
// locked for as long as this process runs. SQLite's locks are the
// kernel's, so the hold goes with the process however it ends.
function holdInstanceLock(userData: string): boolean {
  const db = new DatabaseSync(join(userData, "host.lock"));
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch {
    db.close();
    return false;
  }
  // Kept to the end: a connection collected as garbage lets go of it.
  process.once("exit", () => db.close());
  return true;
}

async function main(): Promise<void> {
  const facts = await headlessFacts();
  if (!holdInstanceLock(facts.userDataPath)) {
    log.error("[host] another host of this build is running on this machine");
    process.exit(nuking ? NUKE_EXIT.running : 1);
  }
  // A nuke's files, before anything opens one: with the lock held, so
  // no other host is using them.
  const nuked = finishPendingNuke(facts.userDataPath);
  if (nuked !== null) finishNuke(nuked.left);
  // A test build's update stand-ins, before anything is spawned.
  takeUpdateEndpointOverrides();
  // A unit starts with the service manager's environment, not the
  // owner's shell's: rebuilt from the login shell (shared/shellEnv.ts).
  // A dev run starts from the developer's terminal and keeps it, but for
  // an agent session's id when an agent started it: nothing the host
  // spawns is that session.
  if (facts.packaged) await applyUserShellEnv();
  for (const harness of HARNESSES) delete process.env[harness.sessionEnv];
  process.on("SIGTERM", () => quit(false));
  process.on("SIGINT", () => quit(false));
  const account = headlessAccount(facts);
  await runHost({
    facts,
    shell: HeadlessShell.layer(facts),
    openSpans: new Map(),
    ready: async ({ port, deviceId }) => {
      log.info(`[host] up on 127.0.0.1:${port} as device ${deviceId}`);
      await account.boot(deviceId);
      if (nuking) await runNuke(facts, account.signOutForNuke);
    },
    failed: async () => {},
  });
}

void main().catch((error: unknown) => {
  log.error("[host] could not start:", error);
  process.exit(1);
});
