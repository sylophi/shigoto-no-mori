// What a pasted string means to the add-project flow: a remote to
// clone, or a path to browse. normalizeRemoteUrl is the judge, the same
// one repo identity uses, so "is a remote" means one thing everywhere:
// a plain path, a `~` path and file:// all name a disk, never a remote.
import { normalizeRemoteUrl } from "@shared/git/repoIdentity.mts";

// The one definition of "a remote a device may be asked to clone": it
// normalizes, and it can't be read as a git option. The clone payload,
// the dialog and the URL handed to another device all ask this.
export function isCloneableRemote(url: string): boolean {
  return !url.trim().startsWith("-") && normalizeRemoteUrl(url) !== null;
}

// The folder `git clone` would make for this URL (the repo's own name,
// `.git` dropped), or null when the string is not a remote.
export function repoNameFromUrl(url: string): string | null {
  if (!isCloneableRemote(url)) return null;
  return normalizeRemoteUrl(url)?.split("/").at(-1) ?? null;
}

// `owner/repo`, the way gh names a GitHub repository. Neither part
// can start with a dash, so it never reads as an option either.
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9-]*\/([A-Za-z0-9._-]+)$/;

export function isGithubShorthand(source: string): boolean {
  const repo = source.trim().match(GITHUB_SHORTHAND)?.[1];
  return repo !== undefined && repo !== "." && repo !== "..";
}

// The remote `source` names: a GitHub `owner/repo` as its https URL,
// anything else as it is.
export function cloneUrlOf(source: string): string {
  return isGithubShorthand(source)
    ? `https://github.com/${source.trim()}`
    : source;
}

// What the clone takes: a remote, or a GitHub repository by its
// `owner/repo`. Only the clone dialog reads the shorthand: everywhere
// else a string like it is a relative path.
export function isCloneSource(source: string): boolean {
  return isCloneableRemote(cloneUrlOf(source));
}

// The folder a clone of `source` makes, or null when it is not one.
export function cloneFolderName(source: string): string | null {
  return repoNameFromUrl(cloneUrlOf(source));
}

// The URL another device should clone to get this repo, out of `git
// remote -v`'s fetch rows. `origin` first: it is what this checkout was
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

// Drops the userinfo of an http(s) URL. An ssh URL's `git@` is the
// login every user of the host shares, not a secret, and the clone
// needs it.
export function stripUrlCredentials(url: string): string {
  // Greedy to the LAST @ before the path: a password may hold a raw one.
  return url.trim().replace(/^(https?:\/\/)[^/]*@/i, "$1");
}
