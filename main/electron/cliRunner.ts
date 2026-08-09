// Spawns the bundled CLI as the app's worktree engine. The five
// lifecycle mutations (create, delete, adopt, done, merge) route
// through here on platforms that ship the CLI, so the app and a
// terminal produce byte-identical behavior; Windows (no CLI) keeps the
// TS engine. The binary is addressed directly -- Resources/ when
// packaged, dist-cli/smd in dev (built by `pnpm dev`) -- so no PATH
// install is involved, and SHIGOMORI_ROOT is pinned to the app's own
// root so the flavor split can never diverge.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/cliDist.mts";
import { app } from "electron";
import { shigomoriRoot } from "../lib/util/paths";
import { isWindows } from "../lib/util/platform";

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

// The CLI's script runner assumes a POSIX shell; Windows keeps the TS
// engine (per-platform behavior there is the TS code's job).
export function cliAvailable(): boolean {
  return !isWindows && cliBinaryPath() !== null;
}

const children = new Set<ChildProcess>();

export function cliChildCount(): number {
  return children.size;
}

// Quit-time reap, mirroring killAllScripts for the TS engine: an CLI
// child mid-create/delete must not outlive the app unnoticed. The CLI
// forwards cleanup to its own children (scripts run in its process
// group via the shared terminal group).
export function killAllCli(): void {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
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
export function runCli(
  args: string[],
  onDoc?: (doc: CliDoc) => void,
): Promise<CliResult> {
  const binary = cliBinaryPath();
  if (binary === null) {
    return Promise.reject(
      new Error(
        "The CLI binary is missing; run `pnpm cli:build --dev` (dev) or reinstall the app.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--json", ...args], {
      env: { ...process.env, SHIGOMORI_ROOT: shigomoriRoot() },
      windowsHide: true,
    });
    children.add(child);

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
      children.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      children.delete(child);
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
