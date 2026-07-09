// Name + icon for the OS file manager, used by "Open in Finder" style
// affordances that must read as "Explorer" on Windows.
import { FolderOpen } from "lucide-react";
import finderIconUrl from "@/app-icons/finder.png";
import { isMac } from "@/lib/platform";

export const fileManagerName = isMac ? "Finder" : "Explorer";

export function FileManagerIcon({
  className = "size-4",
}: {
  className?: string;
}) {
  if (isMac) return <img src={finderIconUrl} alt="" className={className} />;
  return <FolderOpen className={className} />;
}
