// Maps a launcher entry to the right brand asset. Apple- and vendor-provided
// app icons (Cursor, Zed, VS Code, Ghostty, etc.) are extracted PNGs from
// each app's bundle; the rest fall back to svgl SVGs.
import type { ComponentType } from "react";
import { Sparkles } from "lucide-react";
import { FileManagerIcon } from "@/components/ui/file-manager";
import { GithubMark } from "@/components/ui/svgs/github-mark";
import { Intellijidea } from "@/components/ui/svgs/intellijidea";
import { JetbrainsSolid } from "@/components/ui/svgs/jetbrains-solid";
import { Phpstorm } from "@/components/ui/svgs/phpstorm";
import { Pycharm } from "@/components/ui/svgs/pycharm";
import { Rider } from "@/components/ui/svgs/rider";
import { Rubymine } from "@/components/ui/svgs/rubymine";
import { Webstorm } from "@/components/ui/svgs/webstorm";
// The icons come in as ?url, a URL string under any bundler: the
// marketing site's Astro hands a plain image import over as metadata.
import antigravityIconUrl from "@/app-icons/antigravity.png?url";
import chatgptIconUrl from "@/app-icons/chatgpt.png?url";
import claudeIconUrl from "@/app-icons/claude.png?url";
import cmuxIconUrl from "@/app-icons/cmux.png?url";
import cursorIconUrl from "@/app-icons/cursor.png?url";
import ghosttyIconUrl from "@/app-icons/ghostty.png?url";
import githubDesktopIconUrl from "@/app-icons/github-desktop.png?url";
import itermIconUrl from "@/app-icons/iterm.png?url";
import sublimeIconUrl from "@/app-icons/sublime.png?url";
import t3codeIconUrl from "@/app-icons/t3code.png?url";
import terminalIconUrl from "@/app-icons/terminal.png?url";
import vscodeIconUrl from "@/app-icons/vscode.png?url";
import vscodeInsidersIconUrl from "@/app-icons/vscode-insiders.png?url";
import vscodiumIconUrl from "@/app-icons/vscodium.png?url";
import windsurfIconUrl from "@/app-icons/windsurf.png?url";
import xcodeIconUrl from "@/app-icons/xcode.png?url";
import zedIconUrl from "@/app-icons/zed.png?url";
import {
  parseLauncherId,
  WEB_GITHUB_ID,
  type LauncherEntry,
} from "@shared/schemas";

interface LauncherIconProps {
  entry: LauncherEntry;
  className?: string;
}

// Maps, not object literals, so an id like "constructor" can't reach
// the prototype.
const APP_ICON_URL = new Map<string, string>([
  ["cursor", cursorIconUrl],
  ["vscode", vscodeIconUrl],
  ["vscode-insiders", vscodeInsidersIconUrl],
  ["zed", zedIconUrl],
  ["cmux", cmuxIconUrl],
  ["ghostty", ghosttyIconUrl],
  ["terminal", terminalIconUrl],
  ["iterm", itermIconUrl],
  ["github-desktop", githubDesktopIconUrl],
  ["xcode", xcodeIconUrl],
  ["antigravity", antigravityIconUrl],
  ["codex", chatgptIconUrl],
  ["claude", claudeIconUrl],
  ["t3code", t3codeIconUrl],
  ["windsurf", windsurfIconUrl],
  ["vscodium", vscodiumIconUrl],
  ["sublime", sublimeIconUrl],
]);

const SVG_ICON = new Map<string, ComponentType<{ className: string }>>([
  ["finder", FileManagerIcon],
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
]);

export function LauncherIcon({
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

  const appId = parseLauncherId(entry.id)?.id ?? entry.id;
  const url = APP_ICON_URL.get(appId);
  if (url !== undefined) return <img src={url} alt="" className={className} />;
  const Icon = SVG_ICON.get(appId) ?? Sparkles;
  return <Icon className={className} />;
}
