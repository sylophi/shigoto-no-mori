// Maps a launcher entry to the right brand SVG (light/dark aware) or a
// lucide fallback for tools without a recognizable logo.
import { Folder, Sparkles, Terminal } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { CursorLight } from "@/components/ui/svgs/cursorLight";
import { Ghostty } from "@/components/ui/svgs/ghostty";
import { Intellijidea } from "@/components/ui/svgs/intellijidea";
import { Sublimetext } from "@/components/ui/svgs/sublimetext";
import { Vscode } from "@/components/ui/svgs/vscode";
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
    case "vscode":
      return <Vscode className={className} />;
    case "cursor":
      return resolved === "dark" ? (
        <CursorDark className={className} />
      ) : (
        <CursorLight className={className} />
      );
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
    case "ghostty":
      return <Ghostty className={className} />;
    case "iterm":
    case "terminal":
      return <Terminal className={className} />;
    case "finder":
      return <Folder className={className} />;
    default:
      return <Sparkles className={className} />;
  }
}
