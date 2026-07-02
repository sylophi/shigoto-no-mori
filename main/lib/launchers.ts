// App detection + launching for macOS. We hand-roll a small catalog of common
// dev tools, check whether each is installed via .app bundle presence OR a CLI
// shim on PATH, and provide a `launch(target)` that opens the worktree path in
// the chosen target.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { binaryOnPath } from "./util/binaries";
import { ttlValueCache } from "./util/ttlCache";

const exec = promisify(execFile);

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
  bundleNames: string[];
  cli?: string;
}

// The renderer maps each id to a brand SVG (or a lucide fallback). Catalog
// shape mirrors T3 Code's editor list so any tool worth supporting there is
// supported here too.
const CATALOG: CatalogEntry[] = [
  // Editors
  {
    id: "cursor",
    label: "Cursor",
    bundleNames: ["Cursor.app"],
    cli: "cursor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bundleNames: ["Windsurf.app"],
    cli: "windsurf",
  },
  {
    id: "vscode",
    label: "VS Code",
    bundleNames: ["Visual Studio Code.app"],
    cli: "code",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    bundleNames: ["Visual Studio Code - Insiders.app"],
    cli: "code-insiders",
  },
  {
    id: "vscodium",
    label: "VSCodium",
    bundleNames: ["VSCodium.app"],
    cli: "codium",
  },
  {
    id: "zed",
    label: "Zed",
    bundleNames: ["Zed.app", "Zed Preview.app"],
    cli: "zed",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    bundleNames: ["Antigravity.app"],
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
  },
  {
    id: "sublime",
    label: "Sublime Text",
    bundleNames: ["Sublime Text.app"],
    cli: "subl",
  },
  // JetBrains family
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
  // Git clients
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    bundleNames: ["GitHub Desktop.app"],
    cli: "github",
  },
  // Other
  {
    id: "finder",
    label: "Finder",
    bundleNames: ["__finder__"],
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

// Detection is expensive (10 `which` shell-outs + filesystem checks). Cache
// briefly so a single user action that needs the list a few times doesn't
// re-shell each time. Refreshes when the user opens the launcher row again
// after the TTL.
const DETECT_TTL_MS = 5_000;

const detectionCache = ttlValueCache<DetectedApp[]>(DETECT_TTL_MS, () =>
  Promise.all(
    CATALOG.map(async (entry) => {
      const bundleHit = entry.bundleNames.some(appExists);
      const cliHit = entry.cli ? await binaryOnPath(entry.cli) : false;
      return {
        id: entry.id,
        label: entry.label,
        bundleNames: entry.bundleNames,
        cli: entry.cli,
        available: bundleHit || cliHit,
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
  await exec(cli, [worktreePath]);
}

async function openCodexProject(worktreePath: string): Promise<void> {
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", worktreePath);
  await exec("open", [url.toString()]);
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
    await exec("open", [url.toString()]);
    return;
  }

  // `open -a` routes through Launch Services, which ignores in-app window
  // preferences like Zed's "CLI Default Open Behavior" or VS Code's
  // `window.openFoldersInNewWindow`. Prefer the CLI shim so those settings
  // are honored; fall back to the bundle if the shim is missing or broken.
  if (app.cli) {
    try {
      await openWithCli(app.cli, worktreePath);
      return;
    } catch {
      // Fall through.
    }
  }
  await openWithBundle(app.bundleNames, worktreePath);
}

export function launchCustom(command: string, worktreePath: string): void {
  const env = {
    ...process.env,
    SHIGOMORI_WORKSPACE_PATH: worktreePath,
  };
  // Detached + unref so the spawned process outlives this main process,
  // which matches "fire and forget launcher" semantics.
  const child = spawn(command, [], {
    cwd: worktreePath,
    env,
    shell: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
