// Point every download button straight at the latest release's dmg.
// The asset name carries the version, so there is no fixed URL for it.
// Ask GitHub which one is current. Until this resolves, or if it fails,
// the buttons keep their fallback: the latest release's page.
import { REPO_SLUG } from "../site";

interface Release {
  assets?: { name: string; browser_download_url: string }[];
}

export function pointDownloadsAtLatestDmg(): void {
  fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`)
    .then((res) => res.json() as Promise<Release>)
    .then((release) => {
      const dmg = release.assets?.find((asset) => asset.name.endsWith(".dmg"));
      if (!dmg) return;
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        "[data-download]",
      )) {
        link.href = dmg.browser_download_url;
      }
    })
    .catch(() => {});
}
