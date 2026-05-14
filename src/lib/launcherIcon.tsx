// Maps a launcher entry to the right brand asset. Apple- and vendor-provided
// app icons (Cursor, Zed, VS Code, Ghostty, etc.) are extracted PNGs from
// each app's bundle; the rest fall back to svgl SVGs.
import { Sparkles } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { Antigravity } from "@/components/ui/svgs/antigravity";
import { Intellijidea } from "@/components/ui/svgs/intellijidea";
import { JetbrainsSolid } from "@/components/ui/svgs/jetbrainsSolid";
import { Phpstorm } from "@/components/ui/svgs/phpstorm";
import { Pycharm } from "@/components/ui/svgs/pycharm";
import { Rider } from "@/components/ui/svgs/rider";
import { Rubymine } from "@/components/ui/svgs/rubymine";
import { Sublimetext } from "@/components/ui/svgs/sublimetext";
import { Vscodium } from "@/components/ui/svgs/vscodium";
import { Webstorm } from "@/components/ui/svgs/webstorm";
import { WindsurfDark } from "@/components/ui/svgs/windsurfDark";
import { WindsurfLight } from "@/components/ui/svgs/windsurfLight";
import cursorIconUrl from "@/assets/app-icons/cursor.png";
import finderIconUrl from "@/assets/app-icons/finder.png";
import ghosttyIconUrl from "@/assets/app-icons/ghostty.png";
import githubDesktopIconUrl from "@/assets/app-icons/github-desktop.png";
import terminalIconUrl from "@/assets/app-icons/terminal.png";
import vscodeIconUrl from "@/assets/app-icons/vscode.png";
import xcodeIconUrl from "@/assets/app-icons/xcode.png";
import zedIconUrl from "@/assets/app-icons/zed.png";
import type { LauncherEntry } from "@shared/schemas";

interface LauncherIconProps {
  entry: LauncherEntry;
  className?: string;
}

export function LauncherIcon({
  entry,
  className = "size-4",
}: LauncherIconProps) {
  const { resolved } = useTheme();

  if (entry.kind === "custom") {
    return <Sparkles className={className} />;
  }

  const appId = entry.id.replace(/^app:/, "");
  switch (appId) {
    case "cursor":
      return <img src={cursorIconUrl} alt="" className={className} />;
    case "vscode":
    case "vscode-insiders":
      return <img src={vscodeIconUrl} alt="" className={className} />;
    case "zed":
      return <img src={zedIconUrl} alt="" className={className} />;
    case "ghostty":
      return <img src={ghosttyIconUrl} alt="" className={className} />;
    case "terminal":
    case "iterm":
      return <img src={terminalIconUrl} alt="" className={className} />;
    case "github-desktop":
      return <img src={githubDesktopIconUrl} alt="" className={className} />;
    case "xcode":
      return <img src={xcodeIconUrl} alt="" className={className} />;
    case "finder":
      return <img src={finderIconUrl} alt="" className={className} />;
    case "windsurf":
      return resolved === "dark" ? (
        <WindsurfDark className={className} />
      ) : (
        <WindsurfLight className={className} />
      );
    case "antigravity":
      return <Antigravity className={className} />;
    case "vscodium":
      return <Vscodium className={className} />;
    case "sublime":
      return <Sublimetext className={className} />;
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
