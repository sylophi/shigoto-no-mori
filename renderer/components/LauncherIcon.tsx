// Maps a launcher entry to the right brand asset. Apple- and vendor-provided
// app icons (Cursor, Zed, VS Code, Ghostty, etc.) are extracted PNGs from
// each app's bundle; the rest fall back to svgl SVGs.
import { Sparkles } from "lucide-react";
import { Intellijidea } from "@/components/ui/svgs/intellijidea";
import { JetbrainsSolid } from "@/components/ui/svgs/jetbrains-solid";
import { Phpstorm } from "@/components/ui/svgs/phpstorm";
import { Pycharm } from "@/components/ui/svgs/pycharm";
import { Rider } from "@/components/ui/svgs/rider";
import { Rubymine } from "@/components/ui/svgs/rubymine";
import { Webstorm } from "@/components/ui/svgs/webstorm";
import antigravityIconUrl from "@/assets/app-icons/antigravity.png";
import claudeIconUrl from "@/assets/app-icons/claude.png";
import codexIconUrl from "@/assets/app-icons/codex.png";
import cursorIconUrl from "@/assets/app-icons/cursor.png";
import finderIconUrl from "@/assets/app-icons/finder.png";
import ghosttyIconUrl from "@/assets/app-icons/ghostty.png";
import githubDesktopIconUrl from "@/assets/app-icons/github-desktop.png";
import itermIconUrl from "@/assets/app-icons/iterm.png";
import sublimeIconUrl from "@/assets/app-icons/sublime.png";
import terminalIconUrl from "@/assets/app-icons/terminal.png";
import vscodeIconUrl from "@/assets/app-icons/vscode.png";
import vscodeInsidersIconUrl from "@/assets/app-icons/vscode-insiders.png";
import vscodiumIconUrl from "@/assets/app-icons/vscodium.png";
import windsurfIconUrl from "@/assets/app-icons/windsurf.png";
import xcodeIconUrl from "@/assets/app-icons/xcode.png";
import zedIconUrl from "@/assets/app-icons/zed.png";
import type { LauncherEntry } from "@shared/schemas";

interface LauncherIconProps {
  entry: LauncherEntry;
  className?: string;
}

function AppIcon({ src, className }: { src: string; className: string }) {
  return <img src={src} alt="" className={className} />;
}

export function LauncherIcon({
  entry,
  className = "size-4",
}: LauncherIconProps) {
  if (entry.kind === "custom") {
    return <Sparkles className={className} />;
  }

  const appId = entry.id.startsWith("app:") ? entry.id.slice(4) : entry.id;
  switch (appId) {
    case "cursor":
      return <AppIcon src={cursorIconUrl} className={className} />;
    case "vscode":
      return <AppIcon src={vscodeIconUrl} className={className} />;
    case "vscode-insiders":
      return <AppIcon src={vscodeInsidersIconUrl} className={className} />;
    case "zed":
      return <AppIcon src={zedIconUrl} className={className} />;
    case "ghostty":
      return <AppIcon src={ghosttyIconUrl} className={className} />;
    case "terminal":
      return <AppIcon src={terminalIconUrl} className={className} />;
    case "iterm":
      return <AppIcon src={itermIconUrl} className={className} />;
    case "github-desktop":
      return <AppIcon src={githubDesktopIconUrl} className={className} />;
    case "xcode":
      return <AppIcon src={xcodeIconUrl} className={className} />;
    case "finder":
      return <AppIcon src={finderIconUrl} className={className} />;
    case "antigravity":
      return <AppIcon src={antigravityIconUrl} className={className} />;
    case "codex":
      return <AppIcon src={codexIconUrl} className={className} />;
    case "claude":
      return <AppIcon src={claudeIconUrl} className={className} />;
    case "windsurf":
      return <AppIcon src={windsurfIconUrl} className={className} />;
    case "vscodium":
      return <AppIcon src={vscodiumIconUrl} className={className} />;
    case "sublime":
      return <AppIcon src={sublimeIconUrl} className={className} />;
    case "intellij":
      return <Intellijidea className={className} />;
    case "webstorm":
      return <Webstorm className={className} />;
    case "phpstorm":
      return <Phpstorm className={className} />;
    case "pycharm":
      return <Pycharm className={className} />;
    case "rider":
      return <Rider className={className} />;
    case "rubymine":
      return <Rubymine className={className} />;
    // JetBrains IDEs without a dedicated logo on svgl fall back to the
    // generic JetBrains mark.
    case "aqua":
    case "clion":
    case "datagrip":
    case "dataspell":
    case "goland":
    case "rustrover":
      return <JetbrainsSolid className={className} />;
    default:
      return <Sparkles className={className} />;
  }
}
