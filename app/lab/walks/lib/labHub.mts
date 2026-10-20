// The device hub a cross-device walk runs itself: this checkout's
// worker under `wrangler dev` with local bindings only, where a login is
// "lab:<account>" in place of a Clerk session token (hub/src/lab.ts). No
// network and no Clerk, so it runs the same on a laptop and in CI.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect } from "vitest";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";
import { onRunEnd } from "../../../../testProcesses.mts";

const HUB_DIR = join(import.meta.dirname, "..", "..", "..", "..", "hub");
const WRANGLER = join(HUB_DIR, "node_modules", ".bin", "wrangler");

// hub/wrangler.jsonc's worker with the lab's entry and no routes. It is
// written into the hub's own temp folder, since wrangler keeps its build
// beside its config and its state where it is told: nothing of a walk's
// lands in the repository.
const labConfig = () => ({
  name: "shigomori-hub-lab",
  main: join(HUB_DIR, "src", "lab.ts"),
  compatibility_date: "2026-08-01",
  durable_objects: {
    bindings: [{ name: "DEVICE_HUB", class_name: "DeviceHub" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["DeviceHub"] }],
  d1_databases: [
    {
      binding: "DB",
      database_name: "shigomori-hub-lab",
      database_id: "00000000-0000-4000-8000-000000000000",
      migrations_dir: join(HUB_DIR, "migrations"),
    },
  ],
  ratelimits: [
    {
      name: "RATE_LIMIT",
      namespace_id: "3001",
      simple: { limit: 300, period: 60 },
    },
    {
      name: "RATE_LIMIT_OPEN",
      namespace_id: "3002",
      simple: { limit: 60, period: 60 },
    },
  ],
  workers_dev: false,
});

export interface LabHub {
  readonly url: string;
  // The enroll bearer of the walk's one account.
  readonly login: string;
  // The hub goes away, as it does for a Mac that moves between
  // networks, and comes back on the same port with its state.
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export async function startLabHub(): Promise<LabHub> {
  const root = mkdtempSync(join(tmpdir(), "sm-walk-hub-"));
  const config = join(root, "wrangler.json");
  writeFileSync(config, JSON.stringify(labConfig()));
  const state = join(root, "state");
  // SM_WALK_LOGS keeps wrangler's debug log and its output beside the
  // walk's app logs (labApp.mts's close).
  const keep = process.env["SM_WALK_LOGS"];
  const logs =
    keep === undefined || keep === ""
      ? undefined
      : join(keep, basename(expect.getState().testPath ?? root), "hub");
  if (logs !== undefined) mkdirSync(logs, { recursive: true });
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    ...(logs === undefined ? {} : { WRANGLER_LOG_PATH: logs }),
  };
  const output = (chunk: Buffer) => {
    if (logs !== undefined) appendFileSync(join(logs, "output.log"), chunk);
  };
  execFileSync(
    WRANGLER,
    [
      "d1",
      "migrations",
      "apply",
      "shigomori-hub-lab",
      "--local",
      "-c",
      config,
      "--persist-to",
      state,
    ],
    { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  let child: ReturnType<typeof spawn> | null = null;
  let exited = true;
  // Set while a halt (a pause, the stop, the run's end) is the exit's
  // cause. Any other exit is reported as it happens, since the walk
  // only sees it as calls failing later.
  let halting = false;
  let stderr = "";
  // The whole group, workerd with wrangler, whether or not wrangler is
  // still there; a group already gone is no error.
  const signal = (name: NodeJS.Signals) => {
    if (child?.pid === undefined) return;
    try {
      process.kill(-child.pid, name);
    } catch {}
  };
  // Its own process group, so a pause or the stop takes workerd with it.
  const launch = async () => {
    const launched = spawn(
      WRANGLER,
      [
        "dev",
        "-c",
        config,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        state,
        "--var",
        "TICKET_SIGNING_KEY:lab-only-not-a-secret",
      ],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = launched;
    exited = false;
    halting = false;
    launched.once("exit", (code, signalName) => {
      if (child !== launched) return;
      exited = true;
      if (!halting) {
        console.error(
          `[walks] the lab hub exited (${code}, ${signalName}): ${stderr.slice(-1000)}`,
        );
      }
    });
    launched.stdout?.on("data", output);
    launched.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
      output(chunk);
    });
    await waitFor(
      async () => {
        if (exited) throw new Error(`the lab hub exited: ${stderr}`);
        return fetch(url).then(
          () => true,
          () => false,
        );
      },
      "the lab hub",
      60_000,
    );
  };
  const halt = async () => {
    halting = true;
    signal("SIGTERM");
    await waitFor(() => exited, "the lab hub to stop", 10_000).catch(
      async () => {
        signal("SIGKILL");
        await waitFor(() => exited, "the lab hub to be killed", 5_000);
      },
    );
    // workerd goes after wrangler: the port is free only once it has.
    await waitFor(
      () =>
        fetch(url).then(
          () => false,
          () => true,
        ),
      "the lab hub's port to be free",
      10_000,
    );
    // Nothing of its group is left, and its number may go to another's.
    child = null;
  };
  // Detached, it hears no Ctrl-C of the run's: the run's end takes it
  // (../../../../testProcesses.mts).
  const forget = onRunEnd(() => {
    halting = true;
    signal("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  const stop = async () => {
    await halt();
    rmSync(root, { recursive: true, force: true });
    forget();
  };
  try {
    await launch();
  } catch (cause) {
    await stop();
    throw cause;
  }
  return { url, login: "lab:walk", pause: halt, resume: launch, stop };
}
