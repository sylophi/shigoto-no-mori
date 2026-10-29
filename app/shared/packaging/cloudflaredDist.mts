// The tunnel connector the app ships (zero-install remote). Cloudflare Tunnel needs a connector process on
// the machine and the only one Cloudflare supports is cloudflared, but
// "needs cloudflared" must never mean "the user installs cloudflared":
// the app carries the binary exactly as it carries the sm CLI
// (forge.config.ts extraResource, resolved from Resources/ at runtime),
// fetched by scripts/fetch-cloudflared.mts from the release pinned
// here.
//
// One version and one sha256 per asset, committed, so a bump is a
// reviewed diff to this file and the fetch refuses anything else. A
// platform with no pinned asset ships no connector (the runner reports
// "no-binary" and the account page says so).
//
// .mts with no imports, loadable by plain `node scripts/*.mts` and by
// the host through the @shared alias. Never import this from the renderer.
export const CLOUDFLARED_VERSION = "2026.10.4";

// Repo-relative directory the fetched binary lands in (gitignored).
export const CLOUDFLARED_DIST_DIR = "dist-cloudflared";
export const CLOUDFLARED_BINARY_NAME = "cloudflared";

export const CLOUDFLARED_LICENSE = "Apache-2.0";
export const CLOUDFLARED_REPOSITORY =
  "https://github.com/cloudflare/cloudflared";

// A Mac's asset is a tgz holding the binary, and Linux's the binary.
type CloudflaredAsset = { name: string; sha256: string };

// Keyed by node's `${process.platform}-${process.arch}`, the vocabulary
// forge's prePackage hook passes too.
const ASSETS: Record<string, CloudflaredAsset> = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f",
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d",
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
  },
};

export function cloudflaredAsset(
  platform: string,
  arch: string,
): CloudflaredAsset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function cloudflaredDownloadUrl(asset: CloudflaredAsset): string {
  return `${CLOUDFLARED_REPOSITORY}/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
}
