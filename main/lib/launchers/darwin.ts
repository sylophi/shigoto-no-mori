// macOS launcher implementation: the catalog of tools that exist on
// macOS, detected via .app bundle presence OR a CLI shim on PATH, and
// launched through the shim (preferred) or `open -a`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { binaryOnPath } from "../util/binaries";
import {
  addProjectViaBundledCli,
  T3_BUNDLED_CLI_SUBPATH,
  T3CODE_ID,
} from "./t3code";
import type { DetectedApp, PlatformLaunchers } from "./types";

const exec = promisify(execFile);

interface DarwinCatalogEntry {
  id: string;
  label: string;
  // Resolved against APP_ROOTS. `__finder__` is the always-available
  // Finder sentinel.
  bundleNames: string[];
  cli?: string;
}

// The renderer maps each id to a brand SVG (or a lucide fallback).
// Catalog shape mirrors T3 Code's editor list so any tool worth
// supporting there is supported here too.
const CATALOG: DarwinCatalogEntry[] = [
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
  // No `cli`: the npm-installable `t3` binary exists, but its root
  // command starts a server rather than opening a folder, and launching
  // requires the app bundle anyway (see t3code.ts).
  {
    id: T3CODE_ID,
    label: "T3 Code",
    bundleNames: [
      "T3 Code.app",
      "T3 Code (Alpha).app",
      "T3 Code (Nightly).app",
    ],
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
    id: "cmux",
    label: "cmux",
    bundleNames: ["cmux.app"],
    cli: "cmux",
  },
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
  return bundleName === "__finder__" || bundlePath(bundleName) !== null;
}

function bundlePath(bundleName: string): string | null {
  for (const root of APP_ROOTS) {
    const candidate = `${root}/${bundleName}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function detect(): Promise<DetectedApp[]> {
  return Promise.all(
    CATALOG.map(async (entry) => {
      const bundleHit = entry.bundleNames.some(appExists);
      const cliHit = entry.cli ? await binaryOnPath(entry.cli) : false;
      return {
        id: entry.id,
        label: entry.label,
        bundleNames: entry.bundleNames,
        winExe: null,
        cli: entry.cli,
        available: bundleHit || cliHit,
      };
    }),
  );
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

// T3 Code can't open a folder directly (see t3code.ts): register the
// worktree via the CLI bundled in the app, then activate the app. On a
// cold start T3's landing route auto-opens a draft composer for the
// most recently active project -- the one just added -- so this lands
// ready to prompt; when already running it can only surface the project
// and focus the window.
async function launchT3Code(
  app: DetectedApp,
  worktreePath: string,
): Promise<void> {
  const bundle = app.bundleNames
    .map(bundlePath)
    .find((p): p is string => p !== null);
  if (!bundle) {
    throw new Error(`No installed app found for ${app.bundleNames.join(", ")}`);
  }
  const appName = bundle.replace(/^.+\//, "").replace(/\.app$/, "");
  await addProjectViaBundledCli(
    `${bundle}/Contents/MacOS/${appName}`,
    [`${bundle}/Contents/Resources`, ...T3_BUNDLED_CLI_SUBPATH].join("/"),
    worktreePath,
  );
  // Activate by full path, not name: with two variants installed (say
  // stable and Alpha) a name lookup could focus a different copy than
  // the one whose CLI just registered the project.
  await exec("open", ["-a", bundle]);
}

async function launch(app: DetectedApp, worktreePath: string): Promise<void> {
  if (app.id === T3CODE_ID) {
    return launchT3Code(app, worktreePath);
  }
  // `open -a` routes through Launch Services, which ignores in-app window
  // preferences like Zed's "CLI Default Open Behavior" or VS Code's
  // `window.openFoldersInNewWindow`. Prefer the CLI shim so those
  // settings are honored; fall back to the bundle if the shim is missing
  // or broken.
  if (app.cli) {
    try {
      await exec(app.cli, [worktreePath]);
      return;
    } catch {
      // Fall through.
    }
  }
  await openWithBundle(app.bundleNames, worktreePath);
}

export const darwinLaunchers: PlatformLaunchers = { detect, launch };
