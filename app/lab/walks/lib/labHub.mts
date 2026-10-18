// The device hub a cross-device walk runs itself: this checkout's
// worker under `wrangler dev` with local bindings only
// (hub/wrangler.lab.jsonc), where a login is "lab:<account>" in place
// of a Clerk session token (hub/src/lab.ts). No network and no Clerk,
// so it runs the same on a laptop and in CI.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";

const HUB_DIR = join(import.meta.dirname, "..", "..", "..", "..", "hub");
const WRANGLER = join(HUB_DIR, "node_modules", ".bin", "wrangler");
const CONFIG = "wrangler.lab.jsonc";

export interface LabHub {
  readonly url: string;
  // The enroll bearer of the walk's one account.
  readonly login: string;
  stop(): Promise<void>;
}

export async function startLabHub(): Promise<LabHub> {
  const state = mkdtempSync(join(tmpdir(), "sm-walk-hub-"));
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
      CONFIG,
      "--persist-to",
      state,
    ],
    { cwd: HUB_DIR, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  const port = await freeLoopbackPort();
  // Its own process group, so the stop takes workerd with it.
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "-c",
      CONFIG,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      "TICKET_SIGNING_KEY:lab-only-not-a-secret",
    ],
    { cwd: HUB_DIR, env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let exited = false;
  let stderr = "";
  child.once("exit", () => {
    exited = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const stop = async () => {
    if (!exited && child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
      await waitFor(() => exited, "the lab hub to stop", 10_000).catch(() => {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      });
    }
    rmSync(state, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  try {
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
  } catch (cause) {
    await stop();
    throw cause;
  }
  return { url, login: "lab:walk", stop };
}
