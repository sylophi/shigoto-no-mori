// Icon for Finder, used by "Open in Finder" style affordances.
import finderIconUrl from "@/app-icons/finder.png";

export function FileManagerIcon({
  className = "size-4",
}: {
  className?: string;
}) {
  return <img src={finderIconUrl} alt="" className={className} />;
}
