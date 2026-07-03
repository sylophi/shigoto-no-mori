// App detection + launching. We hand-roll a small catalog of common dev
// tools, check whether each is installed (macOS: .app bundle presence,
// Windows: known install paths) OR a CLI shim on PATH, and provide a
// `launch(target)` that opens the worktree path in the chosen target.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { binaryOnPath } from "./util/binaries";
import { ttlValueCache } from "./util/ttlCache";

const exec = promisify(execFile);

const isWindows = process.platform === "win32";

export interface DetectedApp {
  id: string;
  label: string;
  bundleNames: string[];
  cli?: string | undefined;
  available: boolean;
}

interface CatalogEntry {
  id: string;
  label: string;
  // macOS .app bundle names, resolved against APP_ROOTS. `__finder__` is
  // the always-available Finder sentinel.
  bundleNames?: string[];
  // Windows absolute exe candidates (built from env vars at module load).
  // `__explorer__` is the always-available Explorer sentinel.
  winPaths?: string[];
  // PATH shim, probed on every platform the entry supports. On Windows
  // these are the `.cmd`/`.exe` shims installers put on PATH (code,
  // cursor, JetBrains Toolbox scripts, wt, …).
  cli?: string;
}

// Windows installer roots. User-scoped installers (VS Code, Cursor,
// Windsurf, GitHub Desktop, Claude) live under %LOCALAPPDATA%; machine
// installs land in %ProgramFiles%.
const LOCAL_APP_DATA = process.env["LOCALAPPDATA"] ?? "";
const PROGRAM_FILES = process.env["ProgramFiles"] ?? "C:\\Program Files";

function localPrograms(...rest: string[]): string {
  return [LOCAL_APP_DATA, "Programs", ...rest].join("\\");
}

// The renderer maps each id to a brand SVG (or a lucide fallback). Catalog
// shape mirrors T3 Code's editor list so any tool worth supporting there is
// supported here too. Entries with no macOS/Windows install data and no CLI
// hit simply detect as unavailable on that platform.
const CATALOG: CatalogEntry[] = [
  // Editors
  {
    id: "cursor",
    label: "Cursor",
    bundleNames: ["Cursor.app"],
    winPaths: [localPrograms("cursor", "Cursor.exe")],
    cli: "cursor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bundleNames: ["Windsurf.app"],
    winPaths: [localPrograms("Windsurf", "Windsurf.exe")],
    cli: "windsurf",
  },
  {
    id: "vscode",
    label: "VS Code",
    bundleNames: ["Visual Studio Code.app"],
    winPaths: [
      localPrograms("Microsoft VS Code", "Code.exe"),
      `${PROGRAM_FILES}\\Microsoft VS Code\\Code.exe`,
    ],
    cli: "code",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    bundleNames: ["Visual Studio Code - Insiders.app"],
    winPaths: [
      localPrograms("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      `${PROGRAM_FILES}\\Microsoft VS Code Insiders\\Code - Insiders.exe`,
    ],
    cli: "code-insiders",
  },
  {
    id: "vscodium",
    label: "VSCodium",
    bundleNames: ["VSCodium.app"],
    winPaths: [
      localPrograms("VSCodium", "VSCodium.exe"),
      `${PROGRAM_FILES}\\VSCodium\\VSCodium.exe`,
    ],
    cli: "codium",
  },
  {
    id: "zed",
    label: "Zed",
    bundleNames: ["Zed.app", "Zed Preview.app"],
    winPaths: [localPrograms("Zed", "Zed.exe")],
    cli: "zed",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    bundleNames: ["Antigravity.app"],
    winPaths: [localPrograms("Antigravity", "Antigravity.exe")],
    cli: "agy",
  },
  {
    id: "codex",
    label: "Codex",
    bundleNames: ["Codex.app"],
  },
  {
    id: "claude",
    label: "Claude",
    bundleNames: ["Claude.app"],
    winPaths: [`${LOCAL_APP_DATA}\\AnthropicClaude\\claude.exe`],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    bundleNames: ["Sublime Text.app"],
    winPaths: [`${PROGRAM_FILES}\\Sublime Text\\sublime_text.exe`],
    cli: "subl",
  },
  // JetBrains family. Windows installs are versioned directories under
  // Program Files / Toolbox, so detection leans on the Toolbox `scripts`
  // PATH shims, which share names with the macOS shims.
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    bundleNames: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"],
    cli: "idea",
  },
  {
    id: "aqua",
    label: "Aqua",
    bundleNames: ["Aqua.app"],
    cli: "aqua",
  },
  {
    id: "clion",
    label: "CLion",
    bundleNames: ["CLion.app"],
    cli: "clion",
  },
  {
    id: "datagrip",
    label: "DataGrip",
    bundleNames: ["DataGrip.app"],
    cli: "datagrip",
  },
  {
    id: "dataspell",
    label: "DataSpell",
    bundleNames: ["DataSpell.app"],
    cli: "dataspell",
  },
  {
    id: "goland",
    label: "GoLand",
    bundleNames: ["GoLand.app"],
    cli: "goland",
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    bundleNames: ["PhpStorm.app"],
    cli: "phpstorm",
  },
  {
    id: "pycharm",
    label: "PyCharm",
    bundleNames: ["PyCharm.app", "PyCharm CE.app"],
    cli: "pycharm",
  },
  {
    id: "rider",
    label: "Rider",
    bundleNames: ["Rider.app"],
    cli: "rider",
  },
  {
    id: "rubymine",
    label: "RubyMine",
    bundleNames: ["RubyMine.app"],
    cli: "rubymine",
  },
  {
    id: "rustrover",
    label: "RustRover",
    bundleNames: ["RustRover.app"],
    cli: "rustrover",
  },
  {
    id: "webstorm",
    label: "WebStorm",
    bundleNames: ["WebStorm.app"],
    cli: "webstorm",
  },
  // Apple
  {
    id: "xcode",
    label: "Xcode",
    bundleNames: ["Xcode.app"],
    cli: "xed",
  },
  // Terminals (we go further than T3 here)
  {
    id: "ghostty",
    label: "Ghostty",
    bundleNames: ["Ghostty.app"],
  },
  {
    id: "iterm",
    label: "iTerm",
    bundleNames: ["iTerm.app"],
  },
  {
    id: "terminal",
    label: "Terminal",
    bundleNames: ["Utilities/Terminal.app"],
  },
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    // Store apps expose an App Execution Alias rather than a stable
    // install dir; the `wt` alias under WindowsApps is the canonical probe.
    winPaths: [`${LOCAL_APP_DATA}\\Microsoft\\WindowsApps\\wt.exe`],
  },
  // Git clients
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    bundleNames: ["GitHub Desktop.app"],
    winPaths: [`${LOCAL_APP_DATA}\\GitHubDesktop\\GitHubDesktop.exe`],
    cli: "github",
  },
  // Other
  {
    id: "finder",
    label: "Finder",
    bundleNames: ["__finder__"],
  },
  {
    id: "explorer",
    label: "Explorer",
    winPaths: ["__explorer__"],
  },
];

const APP_ROOTS = [
  "/Applications",
  `${homedir()}/Applications`,
  "/System/Applications",
] as const;

function appExists(bundleName: string): boolean {
  if (bundleName === "__finder__") return true;
  for (const root of APP_ROOTS) {
    if (existsSync(`${root}/${bundleName}`)) return true;
  }
  return false;
}

// First Windows exe candidate that exists on disk; `__explorer__` is the
// always-available Explorer sentinel.
function findWinExe(winPaths: string[]): string | null {
  for (const candidate of winPaths) {
    if (candidate === "__explorer__") return candidate;
    if (candidate.startsWith("\\")) continue; // env var missing
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function installHit(entry: CatalogEntry): boolean {
  if (isWindows) {
    return entry.winPaths ? findWinExe(entry.winPaths) !== null : false;
  }
  return entry.bundleNames?.some(appExists) ?? false;
}

// Detection is expensive (10 `which`/`where` shell-outs + filesystem
// checks). Cache briefly so a single user action that needs the list a few
// times doesn't re-shell each time. Refreshes when the user opens the
// launcher row again after the TTL.
const DETECT_TTL_MS = 5_000;

const detectionCache = ttlValueCache<DetectedApp[]>(DETECT_TTL_MS, () =>
  Promise.all(
    CATALOG.map(async (entry) => {
      const installed = installHit(entry);
      const cliHit = entry.cli ? await binaryOnPath(entry.cli) : false;
      return {
        id: entry.id,
        label: entry.label,
        bundleNames: entry.bundleNames ?? [],
        cli: entry.cli,
        available: installed || cliHit,
      };
    }),
  ),
);

export function detectApps(): Promise<DetectedApp[]> {
  return detectionCache.get();
}

export function findDetected(
  id: string,
  all: DetectedApp[],
): DetectedApp | undefined {
  return all.find((a) => a.id === id);
}

// Fire-and-forget spawn that outlives the main process and never throws
// on a nonzero exit (explorer.exe famously exits 1 even on success).
function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Detection already vouched for the binary; a race (uninstalled since
    // the probe) just means the launch silently no-ops.
  });
  child.unref();
}

// Open a custom protocol URL (codex://, claude://) with the OS default
// handler. Kept exec-based rather than Electron's shell.openExternal so
// this module stays importable outside the Electron main process.
async function openUrl(url: string): Promise<void> {
  if (isWindows) {
    // `start` is a cmd.exe builtin; the empty string is the window title
    // slot so the URL isn't mistaken for it.
    await exec("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], {
      windowsVerbatimArguments: true,
    });
    return;
  }
  await exec("open", [url]);
}

async function openWithBundle(
  bundleNames: string[],
  worktreePath: string,
): Promise<void> {
  if (bundleNames.includes("__finder__")) {
    await exec("open", [worktreePath]);
    return;
  }
  const match = bundleNames.find((b) => appExists(b));
  if (!match) {
    throw new Error(`No installed app found for ${bundleNames.join(", ")}`);
  }
  const appName = match.replace(/^.+\//, "").replace(/\.app$/, "");
  await exec("open", ["-a", appName, worktreePath]);
}

async function openWithCli(cli: string, worktreePath: string): Promise<void> {
  // Windows CLI shims are mostly `.cmd` batch wrappers (code.cmd,
  // cursor.cmd, JetBrains Toolbox scripts); execFile can't run those
  // directly, so route through the shell with explicit quoting.
  if (isWindows) {
    await exec("cmd.exe", ["/d", "/s", "/c", `"${cli}" "${worktreePath}"`], {
      windowsVerbatimArguments: true,
    });
    return;
  }
  await exec(cli, [worktreePath]);
}

function openWithWinExe(exe: string, worktreePath: string): void {
  if (exe === "__explorer__") {
    spawnDetached("explorer.exe", [worktreePath]);
    return;
  }
  spawnDetached(exe, [worktreePath]);
}

async function openCodexProject(worktreePath: string): Promise<void> {
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", worktreePath);
  await openUrl(url.toString());
}

export async function launchDetected(
  app: DetectedApp,
  worktreePath: string,
): Promise<void> {
  if (app.id === "codex") {
    await openCodexProject(worktreePath);
    return;
  }

  if (app.id === "claude") {
    const url = new URL("claude://code/new");
    url.searchParams.set("folder", worktreePath);
    await openUrl(url.toString());
    return;
  }

  // Windows Terminal has no "open folder" verb; `-d` starts the default
  // profile in the worktree directory.
  if (app.id === "windows-terminal") {
    spawnDetached("wt.exe", ["-d", worktreePath]);
    return;
  }

  // `open -a` routes through Launch Services, which ignores in-app window
  // preferences like Zed's "CLI Default Open Behavior" or VS Code's
  // `window.openFoldersInNewWindow`. Prefer the CLI shim so those settings
  // are honored; fall back to the bundle/exe if the shim is missing or
  // broken.
  if (app.cli) {
    try {
      await openWithCli(app.cli, worktreePath);
      return;
    } catch {
      // Fall through.
    }
  }
  if (isWindows) {
    const entry = CATALOG.find((e) => e.id === app.id);
    const exe = entry?.winPaths ? findWinExe(entry.winPaths) : null;
    if (!exe) {
      throw new Error(`No installed app found for ${app.label}`);
    }
    openWithWinExe(exe, worktreePath);
    return;
  }
  await openWithBundle(app.bundleNames, worktreePath);
}

export function launchCustom(command: string, worktreePath: string): void {
  const env = {
    ...process.env,
    SHIGOMORI_WORKSPACE_PATH: worktreePath,
  };
  // Detached + unref so the spawned process outlives this main process,
  // which matches "fire and forget launcher" semantics. `shell: true`
  // runs the user's command through /bin/sh on POSIX and cmd.exe on
  // Windows, so commands are authored in the platform's native syntax.
  const child = spawn(command, [], {
    cwd: worktreePath,
    env,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
