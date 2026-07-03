// macOS launcher implementation: the catalog of tools that exist on
// macOS, detected via .app bundle presence OR a CLI shim on PATH, and
// launched through the shim (preferred) or `open -a`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { binaryOnPath } from "../util/binaries";
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
  if (bundleName === "__finder__") return true;
  for (const root of APP_ROOTS) {
    if (existsSync(`${root}/${bundleName}`)) return true;
  }
  return false;
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

async function launch(app: DetectedApp, worktreePath: string): Promise<void> {
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
