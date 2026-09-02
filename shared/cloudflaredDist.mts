// The tunnel connector the app ships (v2 step 10, slice B follow-up:
// zero-install remote). Cloudflare Tunnel needs a connector process on
// the machine and the only one Cloudflare supports is cloudflared, but
// "needs cloudflared" must never mean "the user installs cloudflared":
// the app carries the binary exactly as it carries the sm CLI
// (forge.config.ts extraResource, resolved from Resources/ at runtime),
// fetched by scripts/fetch-cloudflared.mjs from the release pinned
// here.
//
// One version and one sha256 per asset, committed, so a bump is a
// reviewed diff to this file and the fetch refuses anything else.
// Darwin only: the makers build for macOS alone, and a platform with
// no pinned asset ships no connector (the runner reports "no-binary"
// and the Devices page says so).
//
// .mts with no imports, loadable by plain `node scripts/*.mjs` and by
// main through the @shared alias. Never import this from the renderer.
export const CLOUDFLARED_VERSION = "2026.8.3";

// Repo-relative directory the fetched binary lands in (gitignored).
export const CLOUDFLARED_DIST_DIR = "dist-cloudflared";
export const CLOUDFLARED_BINARY_NAME = "cloudflared";

export const CLOUDFLARED_LICENSE = "Apache-2.0";
export const CLOUDFLARED_REPOSITORY =
  "https://github.com/cloudflare/cloudflared";

export type CloudflaredAsset = { name: string; sha256: string };

// Keyed by node's `${process.platform}-${process.arch}`, the vocabulary
// forge's prePackage hook passes too.
const ASSETS: Record<string, CloudflaredAsset> = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99",
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
