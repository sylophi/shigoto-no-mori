// Maps a launcher entry to the right brand SVG (light/dark aware) or a
// lucide fallback for tools without a recognizable logo on svgl.
import { Folder, Sparkles, Terminal } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { CursorLight } from "@/components/ui/svgs/cursorLight";
import { Ghostty } from "@/components/ui/svgs/ghostty";
import { GithubDark } from "@/components/ui/svgs/githubDark";
import { GithubLight } from "@/components/ui/svgs/githubLight";
import { Intellijidea } from "@/components/ui/svgs/intellijidea";
import { JetbrainsSolid } from "@/components/ui/svgs/jetbrainsSolid";
import { Phpstorm } from "@/components/ui/svgs/phpstorm";
import { Pycharm } from "@/components/ui/svgs/pycharm";
import { Rider } from "@/components/ui/svgs/rider";
import { Rubymine } from "@/components/ui/svgs/rubymine";
import { Sublimetext } from "@/components/ui/svgs/sublimetext";
import { Vscode } from "@/components/ui/svgs/vscode";
import { Vscodium } from "@/components/ui/svgs/vscodium";
import { Webstorm } from "@/components/ui/svgs/webstorm";
import { ZedLogo } from "@/components/ui/svgs/zedLogo";
import { ZedLogoDark } from "@/components/ui/svgs/zedLogoDark";
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
      return resolved === "dark" ? (
        <CursorDark className={className} />
      ) : (
        <CursorLight className={className} />
      );
    case "vscode":
    case "vscode-insiders":
      return <Vscode className={className} />;
    case "vscodium":
      return <Vscodium className={className} />;
    case "zed":
      return resolved === "dark" ? (
        <ZedLogoDark className={className} />
      ) : (
        <ZedLogo className={className} />
      );
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
    case "ghostty":
      return <Ghostty className={className} />;
    case "github-desktop":
      return resolved === "dark" ? (
        <GithubLight className={className} />
      ) : (
        <GithubDark className={className} />
      );
    case "iterm":
    case "terminal":
      return <Terminal className={className} />;
    case "finder":
      return <Folder className={className} />;
    // Trae, Kiro, Antigravity, and anything else unknown: generic.
    default:
      return <Sparkles className={className} />;
  }
}
