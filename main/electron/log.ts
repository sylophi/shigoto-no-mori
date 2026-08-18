// Rolling log file for the main process, so a bug report has something
// to attach. A packaged .app launched from Finder has nowhere to print:
// every `console.log` in main/ vanishes, and the only evidence a user
// can hand over is the text of a toast. This tees those same calls to
// `app.getPath("logs")` without taking them away from the terminal
// during `pnpm start`.
//
// Everything here is synchronous and failure-tolerant on purpose. A log
// write must never throw into a caller, and the crash handler's last
// line has to be on disk before the process can go away.
import { app } from "electron";
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { format } from "node:util";

// Bounded by construction: the live file rotates at 1 MiB and two
// rotations are kept, so the logs directory tops out around 3 MiB.
const MAX_BYTES = 1024 * 1024;
const KEEP = 2;

const LEVELS = ["debug", "log", "info", "warn", "error"] as const;

let filePath: string | null = null;
let bytes = 0;

// Absolute path of the live log file, or null when logging never came
// up (unwritable logs directory). Read by the runtime:info IPC so
// Settings can reveal it.
export function logFilePath(): string | null {
  return filePath;
}

// Call once, as early in main as possible: anything logged before this
// runs only reaches the terminal.
export function startFileLogging(): void {
  if (filePath) return;
  let target: string;
  try {
    const dir = app.getPath("logs");
    mkdirSync(dir, { recursive: true });
    // Dev and packaged builds share a logs directory (Electron derives
    // it from the product name), so keep their files apart the way the
    // rest of the app keeps its state apart.
    target = join(dir, app.isPackaged ? "main.log" : "main-dev.log");
    // Touch it now so "Reveal in Finder" has something to select even
    // in a session that never logs a line.
    appendFileSync(target, "");
  } catch {
    // No log file this session. The console keeps working.
    return;
  }
  filePath = target;
  bytes = sizeOf(target);
  teeConsole();
  writeLine(
    "info",
    `session start: app ${app.getVersion()}, electron ${process.versions.electron}, node ${process.versions.node}, darwin ${release()}, pid ${process.pid}`,
  );
}

// Node's default for an uncaught exception is to die, and Electron's is
// a bare error box. Neither leaves a trace once the window is gone.
//
// The app deliberately stays up afterwards. Nearly every exception that
// reaches here comes from one async path (a git call, a file read) and
// leaves the window, the worktrees, and the running scripts perfectly
// usable, while exiting would drop the user's in-flight work and skip
// the before-quit reap that keeps their scripts from being orphaned.
// The renderer already surfaces the failed action, so the log is where
// the detail belongs and Settings is how the user gets to it. No modal
// here on purpose: an app-modal dialog spins a nested run loop on
// macOS, which would freeze the app we just decided to keep alive.
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err, origin) => {
    // Through console so the terminal still sees it during `pnpm start`.
    // The tee writes synchronously, so the entry is on disk by the time
    // this returns even if something exits right after.
    console.error(`[crash] uncaughtException (${origin}):`, err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[crash] unhandledRejection:", reason);
  });
}

// Tee rather than redirect: the original method still runs first, so
// `pnpm start` keeps its console output and DevTools keeps its
// formatting.
function teeConsole(): void {
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        writeLine(level === "log" ? "info" : level, format(...args));
      } catch {
        // A hostile toString in a logged object must not break the
        // caller that merely wanted to print something.
      }
    };
  }
}

function writeLine(level: string, text: string): void {
  if (!filePath) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(text)}\n`;
  try {
    appendFileSync(filePath, line);
    bytes += Buffer.byteLength(line);
    if (bytes >= MAX_BYTES) rotate(filePath);
  } catch {
    // Whatever went wrong (removed directory, full disk, revoked
    // permission) will go wrong on every subsequent line too, so stop
    // rather than pay a failing syscall per log call. Logging is a
    // convenience and gets to disappear quietly. An unbounded file is
    // worse than no file, so a failed rotation gives up the same way.
    filePath = null;
  }
}

// main.log -> main.1.log -> main.2.log, oldest dropped.
function rotate(base: string): void {
  rmSync(rotationPath(base, KEEP), { force: true });
  for (let i = KEEP - 1; i >= 1; i--) {
    renameIfExists(rotationPath(base, i), rotationPath(base, i + 1));
  }
  renameIfExists(base, rotationPath(base, 1));
  // Recreate it right away so the path Settings reveals always points
  // at a file, even in a session that logs nothing after a rotation.
  appendFileSync(base, "");
  bytes = 0;
}

// The rotation slots fill up one session at a time, so walking them
// always steps over names that don't exist yet.
function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

function rotationPath(base: string, index: number): string {
  return base.replace(/\.log$/, `.${index}.log`);
}

function sizeOf(target: string): number {
  try {
    return statSync(target).size;
  } catch {
    return 0;
  }
}

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// The log exists to be sent to someone else, so it errs towards losing
// detail rather than leaking a credential. Nothing in main/ logs the
// environment, and nothing may start: the patterns below cover values
// that travel through the things we do log (git remote URLs, `gh` and
// CLI output, error objects carrying a failed command line).
const REDACTIONS: [RegExp, string][] = [
  // Credentials in a URL, the shape a tokenized git remote takes
  // (https://x-access-token:ghs_xxx@github.com/owner/repo).
  [/([a-z][\w+.-]*:\/\/)[^/\s@]*@/gi, "$1***@"],
  // Authorization headers, before the generic key/value rule below so
  // the scheme keyword survives and the value doesn't.
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 ***"],
  // Provider token shapes, which can turn up anywhere in a message.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "***"],
  // Anything named like a secret that carries a value, which covers
  // env-var assignments and JSON fields alike.
  [
    /((?:token|secret|password|passwd|api[_-]?key|auth|credential)[\w-]*["']?\s*[=:]\s*["']?)[^\s"',;)}\]]+/gi,
    "$1***",
  ],
];

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
