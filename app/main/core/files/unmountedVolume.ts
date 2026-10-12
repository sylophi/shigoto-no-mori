// The volume a path lives on when that volume isn't mounted (an
// external drive unplugged or asleep), or null when it is, or the path
// is on no such volume. Read through symlinks, a dangling one included,
// since a data folder reached by a link to a drive is on that drive. A
// path that doesn't exist yet on a mounted volume is null: a pointer may
// name a folder still to be made.
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function unmountedVolume(path: string, hops = 0): string | null {
  if (hops > 32) return null;
  let at = path;
  const rest: string[] = [];
  // existsSync follows links, so a dangling one reads as missing and
  // its target is looked at instead.
  while (!existsSync(at)) {
    let target: string | undefined;
    try {
      target = readlinkSync(at);
    } catch {
      target = undefined;
    }
    if (target !== undefined) {
      return unmountedVolume(resolve(dirname(at), target, ...rest), hops + 1);
    }
    const up = dirname(at);
    if (up === at) return null;
    rest.unshift(basename(at));
    at = up;
  }
  const real = join(realpathSync(at), ...rest);
  const volume = /^\/Volumes\/[^/]+/.exec(real)?.[0];
  return volume !== undefined && !existsSync(volume) ? volume : null;
}
