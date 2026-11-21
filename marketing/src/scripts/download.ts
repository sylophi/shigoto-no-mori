// Point every download link straight at its platform's file in the
// latest release: its own (data-download="mac"), or with no value, the
// visitor's. The asset names carry the version, so there is no fixed
// URL for them. Ask GitHub which ones are current. Until this resolves,
// or if it fails, the links keep their fallback: the latest release's
// page.
import { REPO_SLUG } from "../site";

// Each platform's file, by the name release.yml gives it.
const ASSET = { mac: "-macOS-arm64-", windows: "-Windows-x64-Setup-" };

interface Release {
  assets?: { name: string; browser_download_url: string }[];
}

export function pointDownloadsAtLatest(): void {
  fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`)
    .then((res) => res.json() as Promise<Release>)
    .then((release) => {
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        "[data-download]",
      )) {
        const platform = (link.dataset.download ||
          document.documentElement.dataset.platform) as keyof typeof ASSET;
        const asset = release.assets?.find(({ name }) =>
          name.includes(ASSET[platform]),
        );
        if (asset) link.href = asset.browser_download_url;
      }
    })
    .catch(() => {});
}
