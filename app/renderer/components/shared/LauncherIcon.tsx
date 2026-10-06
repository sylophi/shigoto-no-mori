// Maps a launcher entry to its brand asset: an icon extracted from the
// app's bundle (scripts/extract-app-icon.sh), else an svgl SVG.
import type { ComponentType } from "react";
import { Sparkles } from "lucide-react";
import { GithubMark } from "@/components/ui/svgs/github-mark";
import { Intellijidea } from "@/components/ui/svgs/intellijidea";
import { JetbrainsSolid } from "@/components/ui/svgs/jetbrains-solid";
import { Phpstorm } from "@/components/ui/svgs/phpstorm";
import { Pycharm } from "@/components/ui/svgs/pycharm";
import { Rider } from "@/components/ui/svgs/rider";
import { Rubymine } from "@/components/ui/svgs/rubymine";
import { Webstorm } from "@/components/ui/svgs/webstorm";
import {
  parseLauncherId,
  WEB_GITHUB_ID,
  type LauncherEntry,
} from "@shared/schemas";

interface LauncherIconProps {
  entry: LauncherEntry;
  className?: string;
}

// Every PNG in app-icons, keyed by file name, which is the app's id in
// cli/embed/launcher-catalog.json (test/launcher-icons.mts holds them
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
