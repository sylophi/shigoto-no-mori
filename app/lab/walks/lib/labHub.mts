// The device hub a cross-device walk runs itself: this checkout's
// worker under `wrangler dev` with local bindings only, where a login is
// "lab:<account>" in place of a Clerk session token (hub/src/lab.ts). No
// network and no Clerk, so it runs the same on a laptop and in CI.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";

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
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
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
      { cwd: root, env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    child = launched;
    exited = false;
    launched.once("exit", () => {
      if (child === launched) exited = true;
    });
    launched.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
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
  };
  // Detached, it hears no Ctrl-C of the run's: the run's end takes it,
  // an exit or a signal that would end the run without one.
  const onExit = () => signal("SIGKILL");
  const ending = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (name: NodeJS.Signals) => {
    signal("SIGKILL");
    for (const each of ending) process.off(each, onSignal);
    process.kill(process.pid, name);
  };
  process.once("exit", onExit);
  for (const each of ending) process.on(each, onSignal);
  const stop = async () => {
    process.off("exit", onExit);
    for (const each of ending) process.off(each, onSignal);
    await halt();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await launch();
  } catch (cause) {
    await stop();
    throw cause;
  }
  return { url, login: "lab:walk", pause: halt, resume: launch, stop };
}
