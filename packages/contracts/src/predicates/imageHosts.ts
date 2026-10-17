// Where an image in markdown from outside the app (a description, a
// pull request's, release notes) may load from in a window: GitHub's own
// hosts, each with its subdomains. An image from anywhere else would
// tell its author who read the text and when; one on a project's
// remote's host is read by the project's device instead
// (projects:remoteImage). GitHub serves attachments from github.com and
// *.githubusercontent.com; GitHub Enterprise Server from its own host, or
// with subdomain isolation from media., uploads., avatars. and raw. under
// it; GHE.com from *.<tenant>.ghe.com and *.githubusercontent.com.
export const GITHUB_IMAGE_HOSTS: readonly string[] = [
  "github.com",
  "githubusercontent.com",
];

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
