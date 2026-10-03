// Icon for Finder, used by "Open in Finder" style affordances.
// The icons come in as ?url, a URL string under any bundler: the
// marketing site's Astro hands a plain image import over as metadata.
import finderIconUrl from "@/app-icons/finder.png?url";

export function FileManagerIcon({
  className = "size-4",
}: {
  className?: string;
}) {
  return <img src={finderIconUrl} alt="" className={className} />;
}
