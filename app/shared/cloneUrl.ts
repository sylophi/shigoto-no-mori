// What a pasted string means to the add-project flow: a remote to
// clone, or a path to browse.
import {
  cloneUrlOf,
  isCloneableRemote,
  normalizeRemoteUrl,
} from "@shigomori/contracts/predicates/remoteUrl";

// The folder `git clone` would make for this URL (the repo's own name,
// `.git` dropped), or null when the string is not a remote.
export function repoNameFromUrl(url: string): string | null {
  if (!isCloneableRemote(url)) return null;
  return normalizeRemoteUrl(url)?.split("/").at(-1) ?? null;
}

// The folder a clone of `source` makes, or null when it is not one.
export function cloneFolderName(source: string): string | null {
  return repoNameFromUrl(cloneUrlOf(source));
}

// The URL another device should clone to get this repo, out of its
// remotes' URLs. `origin` first: it is what this checkout was
// cloned from and pushes to, where identity prefers `upstream` because
// it is asking a different question (whose repo is this). Only a URL
// that normalizes counts, the same rule the clone payload holds its
// input to. An https remote can carry a token in its userinfo, and this
// value leaves the machine, so that part never does.
export function pickCloneUrl(
  remotes: readonly { name: string; url: string }[],
): string | null {
  const usable = remotes.filter((remote) => isCloneableRemote(remote.url));
  const picked =
    usable.find((remote) => remote.name === "origin") ??
    usable.find((remote) => remote.name === "upstream") ??
    usable.toSorted((a, b) => a.name.localeCompare(b.name))[0];
  return picked === undefined ? null : stripUrlCredentials(picked.url);
}

// The remotes to pick that URL from: each as configured, which the
// other device rewrites by its own url.insteadOf, unless its URL names
// no real host (an alias like `gh:owner/repo`, which only this
// machine's rewrite makes a URL). Then that remote as this machine
// rewrites it.
export function handedRemotes(
  configured: readonly { name: string; url: string }[],
  effective: readonly { name: string; url: string }[],
): { name: string; url: string }[] {
  return configured.flatMap((remote) =>
    namesAHost(remote.url)
      ? [remote]
      : effective.filter((each) => each.name === remote.name),
  );
}

const namesAHost = (url: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ||
  (normalizeRemoteUrl(url)?.split("/")[0]?.includes(".") ?? false);

// Drops the userinfo of an http(s) URL. An ssh URL's `git@` is the
// login every user of the host shares, not a secret, and the clone
// needs it.
export function stripUrlCredentials(url: string): string {
  // Greedy to the LAST @ before the path: a password may hold a raw one.
  return url.trim().replace(/^(https?:\/\/)[^/]*@/i, "$1");
}
