// App detection + launching for macOS. We hand-roll a small catalog of common
// dev tools, check whether each is installed via .app bundle presence OR a CLI
// shim on PATH, and provide a `launch(target)` that opens the worktree path in
// the chosen target.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface DetectedApp {
  id: string;
  label: string;
  icon: string;
  bundleNames: string[];
  cli?: string | undefined;
  available: boolean;
}

interface CatalogEntry {
  id: string;
  label: string;
  icon: string;
  bundleNames: string[];
  cli?: string;
}

// Lucide icon names for each entry. Renderer maps them to actual components.
const CATALOG: CatalogEntry[] = [
  {
    id: "vscode",
    label: "VS Code",
    icon: "code",
    bundleNames: ["Visual Studio Code.app", "VSCodium.app"],
    cli: "code",
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: "cursor-text",
    bundleNames: ["Cursor.app"],
    cli: "cursor",
  },
  {
    id: "zed",
    label: "Zed",
    icon: "zap",
    bundleNames: ["Zed.app", "Zed Preview.app"],
    cli: "zed",
  },
  {
    id: "sublime",
    label: "Sublime Text",
    icon: "file-code",
    bundleNames: ["Sublime Text.app"],
    cli: "subl",
  },
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    icon: "square-code",
    bundleNames: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"],
    cli: "idea",
  },
  {
    id: "webstorm",
    label: "WebStorm",
    icon: "square-code",
    bundleNames: ["WebStorm.app"],
    cli: "webstorm",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    icon: "terminal",
    bundleNames: ["Ghostty.app"],
  },
  {
    id: "iterm",
    label: "iTerm",
    icon: "terminal-square",
    bundleNames: ["iTerm.app"],
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: "square-terminal",
    bundleNames: ["Utilities/Terminal.app"],
  },
  {
    id: "finder",
    label: "Finder",
    icon: "folder",
    bundleNames: ["__finder__"],
  },
];

function appExists(bundleName: string): boolean {
  if (bundleName === "__finder__") return true;
  const roots = [
    "/Applications",
    `${homedir()}/Applications`,
    "/System/Applications",
  ];
  for (const root of roots) {
    if (existsSync(`${root}/${bundleName}`)) return true;
  }
  return false;
}

async function cliExists(name: string): Promise<boolean> {
  try {
    await exec("which", [name]);
    return true;
  } catch {
    return false;
  }
}

export async function detectApps(): Promise<DetectedApp[]> {
  return Promise.all(
    CATALOG.map(async (entry) => {
      const bundleHit = entry.bundleNames.some(appExists);
      const cliHit = entry.cli ? await cliExists(entry.cli) : false;
      return {
        id: entry.id,
        label: entry.label,
        icon: entry.icon,
        bundleNames: entry.bundleNames,
        cli: entry.cli,
        available: bundleHit || cliHit,
      };
    }),
  );
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

export async function launchDetected(
  app: DetectedApp,
  worktreePath: string,
): Promise<void> {
  // Prefer the bundle (more reliable, no PATH issues) when present.
  const bundleHit = app.bundleNames.some(appExists);
  if (bundleHit) {
    await openWithBundle(app.bundleNames, worktreePath);
    return;
  }
  if (app.cli && (await cliExists(app.cli))) {
    await openWithCli(app.cli, worktreePath);
    return;
  }
  throw new Error(`${app.label} is no longer available on this machine`);
}

export function launchCustom(
  command: string,
  worktreePath: string,
  port: number | undefined,
): void {
  const env = {
    ...process.env,
    SHIGOTO_WORKSPACE_PATH: worktreePath,
    SHIGOTO_PORT: port ? String(port) : "",
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
