// Icon for Finder, used by "Open in Finder" style affordances. The
// matching display name lives in @/lib/platform (fileManagerName).
import finderIconUrl from "@/app-icons/finder.png";

export function FileManagerIcon({
  className = "size-4",
}: {
  className?: string;
}) {
  return <img src={finderIconUrl} alt="" className={className} />;
}
