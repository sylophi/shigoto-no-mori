// Spawns the bundled CLI as the app's worktree engine. The five
// lifecycle mutations (create, delete, adopt, done, merge) route
// through here, so the app and a terminal produce byte-identical
// behavior. The binary is addressed directly -- Resources/ when
// packaged, dist-cli/smd in dev (built by `pnpm dev`) -- so no PATH
// install is involved: the binary is flavor-stamped at build time and
// reads the same pointer file the app does, so it lands on the app's
// root without being told.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/cliDist.mts";
import { app } from "electron";
import { registerInflightContributor } from "@host/lib/scripts";
import { noteSelfWrite } from "@host/lib/util/selfWrite";
import { signalTreeBestEffort } from "@host/lib/scripts/process";

// One NDJSON document from the CLI's --json stream. `event` is set on
// streamed progress documents (created/phase/carryOver/script/done);
// single-document commands (rm, done, merge) emit result objects
// without it.
export interface CliDoc {
  event?: string;
  [key: string]: unknown;
}

function candidateBinary(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, cliBinaryName("prod"))
    : path.join(app.getAppPath(), CLI_DIST_DIR, cliBinaryName("dev"));
}

// Positive result cached (the binary doesn't move); a miss re-probes so
// a dev binary built after app launch is picked up.
let cachedBinary: string | null = null;

export function cliBinaryPath(): string | null {
  if (cachedBinary !== null) return cachedBinary;
  const candidate = candidateBinary();
  if (existsSync(candidate)) {
    cachedBinary = candidate;
    return candidate;
  }
  return null;
}

// The CLI is the app's only engine. A missing binary (a dev run before
// `pnpm cli:build --dev`) is a hard, actionable error.
export function requireCliBinary(): string {
  const binary = cliBinaryPath();
  if (binary === null) {
    throw new Error(
      "The CLI binary is missing. Run `pnpm cli:build --dev` (dev) or reinstall the app.",
    );
  }
  return binary;
}

const children = new Set<ChildProcess>();

// Children doing invisible housekeeping (the updater's staging
// download): still reaped at quit like every other child, but excluded
// from the busy aggregate -- a background download must not trigger
// the "tasks are running" quit prompt.
let backgroundChildren = 0;

// Every live child, background or not. stateWatcher.ts reads this to
// suppress the fs echo of a CLI child's own writes into the state
// root -- background children churn the root too, so they must count
// here even though they are exempt from the busy aggregate below.
export function cliChildCount(): number {
  return children.size;
}

function cliBusyChildCount(): number {
  return children.size - backgroundChildren;
}

// CLI children are lifecycle operations in flight (create/delete via
// the CLI engine); registering them with the busy aggregate means
// every getBusyOperations consumer counts them, so quitting
// mid-operation still prompts.
registerInflightContributor(cliBusyChildCount);

// Quit-time reap, mirroring killAllScripts for package scripts: a CLI
// child mid-create/delete must not outlive the app unnoticed. Each CLI
// child is spawned detached (its own process group), and the SIGTERM
// goes to the whole group: the Go process doesn't forward signals, so
// signalling only its pid would orphan a running lifecycle script
// (`sh -lc "pnpm install"`) to keep mutating the worktree after quit.
// One CLI child deliberately escapes this reap: the update installer
// (spawnCliDetached), whose whole job starts after we exit.
export function killAllCli(): void {
  for (const child of children) {
    try {
      if (child.pid !== undefined) signalTreeBestEffort(child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

// Spawn a CLI command that must outlive this process (the update
// installer waits for our pid to exit before swapping bundles).
// Deliberately NOT tracked in `children`: killAllCli reaping it at
// quit would defeat its purpose. Settles only once the child actually
// spawned (or failed to):
// spawn errors arrive asynchronously, and an unhandled 'error' event
// on a ChildProcess is an uncaught exception in the main process --
// the caller is about to quit on success, so it must not do that on a
// child that never started.
export async function spawnCliDetached(args: string[]): Promise<void> {
  const binary = requireCliBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export interface CliResult {
  code: number;
  docs: CliDoc[];
  stderrTail: string;
}

// Runs `sm --json <args>`, parsing each stdout line as a document and
// forwarding it to onDoc as it arrives. Resolves with every document
// once the process exits; rejects only on spawn failure -- non-zero
// exits resolve normally since the error payload is in the documents.
// extraEnv overlays the app's environment (used by cliShell.ts to pass
// the user's real shell-config env vars, which launchd strips).
// opts.background exempts the child from the busy aggregate (see
// backgroundChildren). opts.timeoutMs SIGKILLs the child's process
// group when it runs that long, so a wedged child (a stuck subprocess
// on the Go side) can't hold the returned promise open forever -- the
// kill surfaces as a normal non-zero close.
export async function runCli(
  args: string[],
  onDoc?: (doc: CliDoc) => void,
  extraEnv?: Record<string, string>,
  opts?: { background?: boolean; timeoutMs?: number },
): Promise<CliResult> {
  const binary = requireCliBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--json", ...args], {
      env: { ...process.env, ...extraEnv },
      // Own process group so killAllCli can signal the CLI and any
      // lifecycle script it spawned as one unit (see killAllCli).
      detached: true,
    });
    children.add(child);
    if (opts?.background) backgroundChildren++;
    const killTimer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            try {
              if (child.pid !== undefined)
                signalTreeBestEffort(child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
          }, opts.timeoutMs)
        : null;
    // error and close can both fire for one child, so release runs once.
    const release = () => {
      if (killTimer !== null) clearTimeout(killTimer);
      if (children.delete(child) && opts?.background) backgroundChildren--;
    };

    const docs: CliDoc[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const doc = JSON.parse(line) as CliDoc;
          docs.push(doc);
          onDoc?.(doc);
        } catch {
          console.warn("[cli] unparseable output line:", line.slice(0, 200));
        }
      }
    });

    // Human diagnostics land on stderr; keep a tail for error surfaces.
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });

    child.on("error", (error) => {
      release();
      reject(error);
    });
    child.on("close", (code) => {
      release();
      // The CLI's writes into the root are the app's own doing; mark
      // them so the state watcher doesn't refetch-storm on the echo.
      // (While the child runs, the watcher checks cliChildCount().)
      noteSelfWrite();
      resolve({ code: code ?? -1, docs, stderrTail });
    });
  });
}

// The failure message for a run whose documents carried no result: the
// CLI's {ok:false, error} document when present, else the exit code.
export function cliFailureMessage(result: CliResult, fallback: string): string {
  const errorDoc = result.docs.find(
    (doc) => doc["ok"] === false && typeof doc["error"] === "string",
  );
  if (errorDoc) return errorDoc["error"] as string;
  return `${fallback} (CLI exit ${result.code})`;
}
