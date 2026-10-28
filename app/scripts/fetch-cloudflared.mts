// Fetches the pinned cloudflared release into dist-cloudflared/ so the
// app ships the tunnel connector instead of asking the user to install
// it. The same shape as build-file-sync.mts, with a download in
// place of a compile: forge's prePackage hook runs it for the
// target platform and ships the result via extraResource, and
// `pnpm start` runs it best-effort so dev builds carry the binary too.
//
// Supply-chain discipline: the version AND the sha256 of every asset
// are committed (shared/packaging/cloudflaredDist.mts). The download
// (lib/fetchPinned.mts) is refused unless the digest matches, nothing
// is executed during the fetch, and a bump is an ordinary reviewed
// change to that one file.
//
// Run: node scripts/fetch-cloudflared.mts [--platform darwin] [--arch arm64] [--best-effort]
import { execFileSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
  CLOUDFLARED_VERSION,
  cloudflaredAsset,
  cloudflaredDownloadUrl,
} from "../shared/packaging/cloudflaredDist.mts";
import { appRoot } from "./lib/appRoot.mts";
import { fetchPinned } from "./lib/fetchPinned.mts";

const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const at = args.indexOf(name);
  return (at >= 0 ? args[at + 1] : undefined) ?? fallback;
}

const platform = flag("--platform", process.platform);
const arch = flag("--arch", process.arch);
// Dev runs never fail the start on a missing download: tunnels simply
// stay off (the runner reports no-binary) until the next `pnpm start`.
// Packaging has no such leniency, a build must carry the connector.
const bestEffort = args.includes("--best-effort");

function fail(message: string): never {
  if (bestEffort) {
    console.warn(`[cloudflared] ${message} (tunnels stay off this run)`);
    process.exit(0);
  }
  console.error(`[cloudflared] ${message}`);
  process.exit(1);
}

const asset = cloudflaredAsset(platform, arch);
if (asset === null) fail(`no pinned cloudflared asset for ${platform}-${arch}`);

let kept: boolean;
try {
  kept = await fetchPinned({
    label: "cloudflared",
    distDir: join(appRoot, CLOUDFLARED_DIST_DIR),
    binaryName: CLOUDFLARED_BINARY_NAME,
    stamp: `${CLOUDFLARED_VERSION} ${platform}-${arch}\n`,
    url: cloudflaredDownloadUrl(asset),
    name: asset.name,
    sha256: asset.sha256,
    unpack: (bytes, staging) => {
      const binaryPath = join(staging, CLOUDFLARED_BINARY_NAME);
      if (asset.name.endsWith(".tgz")) {
        const archive = join(staging, asset.name);
        writeFileSync(archive, bytes);
        execFileSync("tar", [
          "-xzf",
          archive,
          "-C",
          staging,
          CLOUDFLARED_BINARY_NAME,
        ]);
        rmSync(archive);
      } else {
        writeFileSync(binaryPath, bytes);
      }
      chmodSync(binaryPath, 0o755);
    },
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
console.log(
  kept
    ? `[cloudflared] ${CLOUDFLARED_VERSION} (${platform}-${arch}) already in ${CLOUDFLARED_DIST_DIR}/`
    : `[cloudflared] ${CLOUDFLARED_VERSION} ready at ${CLOUDFLARED_DIST_DIR}/${CLOUDFLARED_BINARY_NAME}`,
);
