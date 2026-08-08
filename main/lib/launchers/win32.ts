// Windows launcher implementation: the catalog of tools that exist on
// Windows, detected via known install paths OR a CLI shim on PATH, and
// launched by spawning the resolved exe directly (preferred; no cmd.exe
// involved) or through the `.cmd` shim as a fallback.
//
// macOS-only tools (Xcode, iTerm, Ghostty, Terminal.app, Finder, the
// Codex app, T3 Code) are deliberately absent -- a Windows user should
// never see them, not even as "supported but not installed".
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isWindowsStyle } from "@shared/worktreeLayout";
import { binaryOnPath } from "../util/binaries";
import { toNativePath } from "../util/paths";
import type { DetectedApp, PlatformLaunchers } from "./types";

interface Win32CatalogEntry {
  id: string;
  label: string;
  // Absolute exe candidates (built from env vars at module load).
  // `__explorer__` is the always-available Explorer sentinel.
  winPaths: string[];
  // Arguments the exe takes to open a directory; defaults to the bare
  // path. Windows Terminal needs `-d <path>`.
  winArgs?: (worktreePath: string) => string[];
  // PATH shim (`.cmd`/`.exe`) installers put on PATH.
  cli?: string;
}

// Installer roots. User-scoped installers (VS Code, Cursor, Windsurf,
// GitHub Desktop, Claude) live under %LOCALAPPDATA%; machine installs
// land in %ProgramFiles%.
const LOCAL_APP_DATA = process.env["LOCALAPPDATA"] ?? "";
const PROGRAM_FILES = process.env["ProgramFiles"] ?? "C:\\Program Files";

function localPrograms(...rest: string[]): string {
  return [LOCAL_APP_DATA, "Programs", ...rest].join("\\");
}

const CATALOG: Win32CatalogEntry[] = [
  // Editors
  {
    id: "cursor",
    label: "Cursor",
    winPaths: [localPrograms("cursor", "Cursor.exe")],
    cli: "cursor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    winPaths: [localPrograms("Windsurf", "Windsurf.exe")],
    cli: "windsurf",
  },
  {
    id: "vscode",
    label: "VS Code",
    winPaths: [
      localPrograms("Microsoft VS Code", "Code.exe"),
      `${PROGRAM_FILES}\\Microsoft VS Code\\Code.exe`,
    ],
    cli: "code",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    winPaths: [
      localPrograms("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      `${PROGRAM_FILES}\\Microsoft VS Code Insiders\\Code - Insiders.exe`,
    ],
    cli: "code-insiders",
  },
  {
    id: "vscodium",
    label: "VSCodium",
    winPaths: [
      localPrograms("VSCodium", "VSCodium.exe"),
      `${PROGRAM_FILES}\\VSCodium\\VSCodium.exe`,
    ],
    cli: "codium",
  },
  {
    id: "zed",
    label: "Zed",
    winPaths: [localPrograms("Zed", "Zed.exe")],
    cli: "zed",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    winPaths: [localPrograms("Antigravity", "Antigravity.exe")],
    cli: "agy",
  },
  {
    id: "claude",
    label: "Claude",
    winPaths: [`${LOCAL_APP_DATA}\\AnthropicClaude\\claude.exe`],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    winPaths: [`${PROGRAM_FILES}\\Sublime Text\\sublime_text.exe`],
    cli: "subl",
  },
  // JetBrains family. Installs are versioned directories under Program
  // Files / Toolbox, so detection leans on the Toolbox `scripts` PATH
  // shims, which share names with the macOS shims.
  { id: "intellij", label: "IntelliJ IDEA", winPaths: [], cli: "idea" },
  { id: "aqua", label: "Aqua", winPaths: [], cli: "aqua" },
  { id: "clion", label: "CLion", winPaths: [], cli: "clion" },
  { id: "datagrip", label: "DataGrip", winPaths: [], cli: "datagrip" },
  { id: "dataspell", label: "DataSpell", winPaths: [], cli: "dataspell" },
  { id: "goland", label: "GoLand", winPaths: [], cli: "goland" },
  { id: "phpstorm", label: "PhpStorm", winPaths: [], cli: "phpstorm" },
  { id: "pycharm", label: "PyCharm", winPaths: [], cli: "pycharm" },
  { id: "rider", label: "Rider", winPaths: [], cli: "rider" },
  { id: "rubymine", label: "RubyMine", winPaths: [], cli: "rubymine" },
  { id: "rustrover", label: "RustRover", winPaths: [], cli: "rustrover" },
  { id: "webstorm", label: "WebStorm", winPaths: [], cli: "webstorm" },
  // Terminals
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    // Store apps expose an App Execution Alias rather than a stable
    // install dir; the `wt` alias under WindowsApps is the canonical
    // probe.
    winPaths: [`${LOCAL_APP_DATA}\\Microsoft\\WindowsApps\\wt.exe`],
    winArgs: (worktreePath) => ["-d", worktreePath],
  },
  // Git clients
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    winPaths: [`${LOCAL_APP_DATA}\\GitHubDesktop\\GitHubDesktop.exe`],
    cli: "github",
  },
  // Other
  {
    id: "explorer",
    label: "Explorer",
    winPaths: ["__explorer__"],
  },
];

// First exe candidate that exists on disk; `__explorer__` is the
// always-available Explorer sentinel. Candidates that aren't
// Windows-absolute mean the env var they were built from was missing.
function findWinExe(winPaths: string[]): string | null {
  for (const candidate of winPaths) {
    if (candidate === "__explorer__") return candidate;
    if (!isWindowsStyle(candidate)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function detect(): Promise<DetectedApp[]> {
  return Promise.all(
    CATALOG.map(async (entry) => {
      const winExe = findWinExe(entry.winPaths);
      const cliHit = entry.cli ? await binaryOnPath(entry.cli) : false;
      return {
        id: entry.id,
        label: entry.label,
        bundleNames: [],
        winExe,
        cli: entry.cli,
        available: winExe !== null || cliHit,
      };
    }),
  );
}

// Detached spawn that outlives the main process. Resolves once the OS
// accepts the process (the `spawn` event) so failures like ENOENT reach
// the caller as errors instead of vanishing, but never waits for -- or
// judges -- the exit code (explorer.exe famously exits 1 even on
// success). Never awaiting the exit also matters for the shell path
// below: a batch shim waits on GUI processes it starts synchronously,
// so awaiting it (exec-style) would pin the launch IPC until the IDE
// closes -- and exec's output buffering could even kill the tree later
// on maxBuffer. detached means DETACHED_PROCESS, so no console window
// is created; windowsHide covers children that allocate their own.
function spawnDetached(
  command: string,
  args: string[],
  opts: { shell?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: opts.shell ?? false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openWithCli(cli: string, worktreePath: string): Promise<void> {
  // Detection results are cached (main-side TTL plus the renderer's
  // query cache), and the detached shell spawn below can't report a
  // missing shim -- cmd.exe itself spawns fine either way. Re-probe so
  // a stale entry surfaces as a launch error instead of a silent no-op.
  if (!(await binaryOnPath(cli))) {
    throw new Error(`"${cli}" is not on PATH`);
  }
  // CLI shims are mostly `.cmd` batch wrappers (code.cmd, cursor.cmd,
  // JetBrains Toolbox scripts); a plain spawn can't run those directly,
  // so route through the shell. Quotes are illegal in Windows paths, so
  // plain wrapping is sufficient. Residual cmd.exe caveat: %VAR% expands
  // even inside quotes, so a path containing a defined env-var name
  // opens the wrong folder -- unavoidable with cmd, which is why the
  // resolved-exe launch is preferred.
  await spawnDetached(`"${cli}" "${worktreePath}"`, [], { shell: true });
}

async function launch(app: DetectedApp, worktreePath: string): Promise<void> {
  // Worktree paths flow in as git porcelain reports them -- forward
  // slashes -- which explorer.exe rejects outright (it falls back to the
  // default view) and other tools merely tolerate. Fold to native
  // backslashes before handing the path to anything.
  const nativePath = toNativePath(worktreePath);
  // Prefer the exe detection resolved -- a direct spawn with an argument
  // array, no cmd.exe and none of its quoting/expansion rules. Fall back
  // to the CLI shim only when no exe was found.
  if (app.winExe) {
    if (app.winExe === "__explorer__") {
      await spawnDetached("explorer.exe", [nativePath]);
      return;
    }
    const entry = CATALOG.find((e) => e.id === app.id);
    const args = entry?.winArgs?.(nativePath) ?? [nativePath];
    await spawnDetached(app.winExe, args);
    return;
  }
  if (app.cli) {
    await openWithCli(app.cli, nativePath);
    return;
  }
  throw new Error(`No installed app found for ${app.label}`);
}

export const win32Launchers: PlatformLaunchers = { detect, launch };
