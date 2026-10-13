// The GitHub host a repo's gh runs are pinned to (GitHub.hostOf): `gh
// api` asks github.com unless told otherwise, even in a repo on an
// Enterprise host, so a repo's merge settings and stacks would be read
// from the wrong server.
import { normalizeRemoteUrl } from "@shigomori/contracts/predicates/remoteUrl";

// gh's own order for the repo a checkout means (its remote resolver):
// upstream, then github, then origin, then the rest as git lists them.
const GH_REMOTE_ORDER = ["origin", "github", "upstream"];

// The hosts gh is signed in to: the top-level keys of its hosts.yml
// (`content`, empty for none), and github.com even without one.
// Lowercased, as normalizeRemoteUrl leaves a remote's host.
export function ghKnownHosts(content: string): Set<string> {
  const hosts = new Set<string>(["github.com"]);
  for (const line of content.split("\n")) {
    const m = line.match(/^([^\s:#]+):\s*$/);
    if (m?.[1]) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

// The host of the remote gh resolves the repo from, among those on a
// host gh is signed in to, or null for none. `remotes` as git lists
// them; a remote's first URL is its fetch URL. Pinning gh to it keeps
// gh on the repo it would pick anyway when a checkout has remotes on
// two hosts.
export function ghHostFor(
  remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>,
  known: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();
  let best: { host: string; rank: number } | null = null;
  for (const { name, url } of remotes) {
    if (seen.has(name)) continue;
    seen.add(name);
    const normalized = normalizeRemoteUrl(url);
    if (normalized === null) continue;
    const host = normalized.slice(0, normalized.indexOf("/"));
    if (!known.has(host)) continue;
    const rank = GH_REMOTE_ORDER.indexOf(name);
    if (best === null || rank > best.rank) best = { host, rank };
  }
  return best?.host ?? null;
}
