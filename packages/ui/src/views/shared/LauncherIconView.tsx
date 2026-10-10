// Maps a launcher entry to its brand asset: an icon extracted from the
// app's bundle (scripts/extract-app-icon.sh) or, for a terminal tool,
// one made from its project's own logo, else an SVG (mostly svgl's).
import type { ComponentType } from "react";
import { Sparkles } from "lucide-react";
import { Copilot } from "../../primitives/svgs/copilot.tsx";
import { Gemini } from "../../primitives/svgs/gemini.tsx";
import { GithubMark } from "../../primitives/svgs/github-mark.tsx";
import { Gitui } from "../../primitives/svgs/gitui.tsx";
import { Helix } from "../../primitives/svgs/helix.tsx";
import { Intellijidea } from "../../primitives/svgs/intellijidea.tsx";
import { JetbrainsSolid } from "../../primitives/svgs/jetbrains-solid.tsx";
import { Neovim } from "../../primitives/svgs/neovim.tsx";
import { Phpstorm } from "../../primitives/svgs/phpstorm.tsx";
import { Pi } from "../../primitives/svgs/pi.tsx";
import { Pycharm } from "../../primitives/svgs/pycharm.tsx";
import { Rider } from "../../primitives/svgs/rider.tsx";
import { Rubymine } from "../../primitives/svgs/rubymine.tsx";
import { Vim } from "../../primitives/svgs/vim.tsx";
import { Webstorm } from "../../primitives/svgs/webstorm.tsx";
import {
  parseLauncherId,
  WEB_GITHUB_ID,
  type LauncherEntry,
} from "@shigomori/contracts/schemas/index";

interface LauncherIconProps {
  entry: LauncherEntry;
  className?: string;
}

// Every PNG in app-icons, keyed by file name, which is the app's id in
// packages/engine/src/data/launcher-catalog.json (test/launcher-icons.mts holds them
// to it). A Map, not an object literal, so an id like "constructor"
// can't reach the prototype.
const APP_ICON_URL = new Map(
  Object.entries(
    import.meta.glob<string>("../../app-icons/*.png", {
      eager: true,
      query: "?url",
      import: "default",
    }),
  ).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4), url]),
);

// Terminal tools wearing their app's icon.
const ICON_ALIAS = new Map([
  ["claude-code", "claude"],
  ["codex-cli", "codex"],
  ["cursor-agent", "cursor"],
]);

const SVG_ICON = new Map<string, ComponentType<{ className: string }>>([
  ["intellij", Intellijidea],
  ["webstorm", Webstorm],
  ["phpstorm", Phpstorm],
  ["pycharm", Pycharm],
  ["rider", Rider],
  ["rubymine", Rubymine],
  // JetBrains IDEs without a dedicated logo on svgl fall back to the
  // generic JetBrains mark.
  ["aqua", JetbrainsSolid],
  ["clion", JetbrainsSolid],
  ["datagrip", JetbrainsSolid],
  ["dataspell", JetbrainsSolid],
  ["goland", JetbrainsSolid],
  ["rustrover", JetbrainsSolid],
  ["gemini", Gemini],
  ["copilot", Copilot],
  ["neovim", Neovim],
  ["vim", Vim],
  ["helix", Helix],
  ["gitui", Gitui],
  ["pi", Pi],
]);

export function LauncherIconView({
  entry,
  className = "size-4",
}: LauncherIconProps) {
  if (entry.kind === "custom") {
    return <Sparkles className={className} />;
  }

  if (entry.kind === "web") {
    if (entry.id === WEB_GITHUB_ID) return <GithubMark className={className} />;
    return <Sparkles className={className} />;
  }

  const id = parseLauncherId(entry.id)?.id ?? entry.id;
  const appId = ICON_ALIAS.get(id) ?? id;
  const url = APP_ICON_URL.get(appId);
  if (url !== undefined) return <img src={url} alt="" className={className} />;
  const Icon = SVG_ICON.get(appId) ?? Sparkles;
  return <Icon className={className} />;
}
