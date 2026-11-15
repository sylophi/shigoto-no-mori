// The file manager of the machine the window runs on, which every
// "Reveal" opens: a reveal is only ever offered for this machine's disk.
import explorerIconUrl from "../app-icons/explorer.png";
import finderIconUrl from "../app-icons/finder.png";
import { viewerOs } from "../lib/platform.ts";

const FILE_MANAGER =
  viewerOs === "windows"
    ? { name: "File Explorer", icon: explorerIconUrl }
    : { name: "Finder", icon: finderIconUrl };

export const FILE_MANAGER_NAME = FILE_MANAGER.name;

export function FileManagerIcon({
  className = "size-4",
}: {
  className?: string;
}) {
  return <img src={FILE_MANAGER.icon} alt="" className={className} />;
}
