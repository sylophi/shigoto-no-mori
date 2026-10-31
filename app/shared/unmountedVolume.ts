// The volume a path lives on when that volume isn't mounted (an
// external drive unplugged or asleep), or null when it is, or the path
// is on no such volume. The path is resolved a part at a time as the
// system does, each link followed where it stands (a dangling one
// included, and a `..` after it read from its target), since a data
// folder reached by a link to a drive is on that drive. A path that
// doesn't exist yet on a mounted volume is null: a pointer may name a
// folder still to be made.
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const VOLUMES = "/Volumes";
const MAX_LINKS = 32;

const linkAt = (path: string): string | undefined => {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
};

export function unmountedVolume(path: string): string | null {
  let volumes: string;
  try {
    volumes = realpathSync(VOLUMES);
  } catch {
    return null;
  }
  let at = "/";
  const parts = path.split("/");
  let links = 0;
  while (parts.length > 0) {
    const part = parts.shift();
    if (part === undefined || part === "" || part === ".") continue;
    if (part === "..") {
      at = dirname(at);
      continue;
    }
    const next = join(at, part);
    const target = linkAt(next);
    if (target === undefined) {
      at = next;
      // A mount point that isn't there ends the lookup, as it does the
      // system's: a `..` after it can't step back out.
      if (dirname(at) === volumes && !existsSync(at)) {
        return join(VOLUMES, part);
      }
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return null;
    if (target.startsWith("/")) at = "/";
    parts.unshift(...target.split("/"));
  }
  return null;
}
