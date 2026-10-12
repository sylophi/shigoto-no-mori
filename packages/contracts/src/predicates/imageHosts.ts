// Where an image in markdown from outside the app (a description, a
// pull request's, release notes) may load from: GitHub's own hosts, and
// the hosts of the remotes the app knows, each with its subdomains. An
// image from anywhere else would tell its author who read the text and
// when. GitHub serves attachments from github.com and
// *.githubusercontent.com; GitHub Enterprise Server from its own host, or
// with subdomain isolation from media., uploads., avatars. and raw. under
// it; GHE.com from *.<tenant>.ghe.com and *.githubusercontent.com.
import { normalizeRemoteUrl } from "./remoteUrl.ts";

export const GITHUB_IMAGE_HOSTS: readonly string[] = [
  "github.com",
  "githubusercontent.com",
];

// The host a remote lives on (an https or ssh URL, scp-like included),
// or null for one that names none.
export function remoteHost(remote: string): string | null {
  const host = normalizeRemoteUrl(remote)?.split("/")[0]?.toLowerCase();
  return host === undefined || !/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host)
    ? null
    : host;
}

// Whether an image URL is served over https by one of `hosts` or a
// subdomain of one. A data: URL, which loads nothing, passes too.
export function isAllowedImage(src: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol === "data:") return true;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return hosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}
