// Fetches the pinned cloudflared release into dist-cloudflared/ so the
// app ships the tunnel connector instead of asking the user to install
// it. The same shape as build-cli.mjs for the Go CLI, with a download
// in place of a compile: forge's prePackage hook runs it for the
// target platform and ships the result via extraResource, and
// `pnpm start` runs it best-effort so dev builds carry the binary too.
//
// Supply-chain discipline: the version AND the sha256 of every asset
// are committed (shared/cloudflaredDist.mts). The download is refused
// unless the digest matches, nothing is executed during the fetch, and
// a bump is an ordinary reviewed change to that one file.
//
// Run: node scripts/fetch-cloudflared.mjs [--platform darwin] [--arch arm64] [--best-effort]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
  CLOUDFLARED_VERSION,
  cloudflaredAsset,
  cloudflaredDownloadUrl,
} from "../shared/cloudflaredDist.mts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function flag(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}

const platform = flag("--platform", process.platform);
const arch = flag("--arch", process.arch);
// Dev runs never fail the start on a missing download: tunnels simply
// stay off (the runner reports no-binary) until the next `pnpm start`.
// Packaging has no such leniency, a build must carry the connector.
const bestEffort = args.includes("--best-effort");

const distDir = join(repoRoot, CLOUDFLARED_DIST_DIR);
const binary = join(distDir, CLOUDFLARED_BINARY_NAME);
const stampPath = join(distDir, "stamp");
const stamp = `${CLOUDFLARED_VERSION} ${platform}-${arch}\n`;

function fail(message) {
  if (bestEffort) {
    console.warn(`[cloudflared] ${message} (tunnels stay off this run)`);
    process.exit(0);
  }
  console.error(`[cloudflared] ${message}`);
  process.exit(1);
}

const asset = cloudflaredAsset(platform, arch);
if (asset === null) fail(`no pinned cloudflared asset for ${platform}-${arch}`);

if (
  existsSync(binary) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, "utf8") === stamp
) {
  console.log(
    `[cloudflared] ${CLOUDFLARED_VERSION} (${platform}-${arch}) already in ${CLOUDFLARED_DIST_DIR}/`,
  );
  process.exit(0);
}

const url = cloudflaredDownloadUrl(asset);
console.log(`[cloudflared] fetching ${url}`);
let bytes;
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
} catch (error) {
  fail(`download failed: ${error instanceof Error ? error.message : error}`);
}
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== asset.sha256) {
  fail(
    `sha256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${digest}`,
  );
}

// Unpack into a staging dir and swap it in only once the binary is
// ready, so a failed extraction (a renamed archive member, a full
// disk) leaves whatever copy was already there untouched.
const staging = `${distDir}.tmp`;
try {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, asset.name);
  writeFileSync(archive, bytes);
  // The darwin assets are a tgz holding the one binary.
  execFileSync("tar", [
    "-xzf",
    archive,
    "-C",
    staging,
    CLOUDFLARED_BINARY_NAME,
  ]);
  rmSync(archive);
  chmodSync(join(staging, CLOUDFLARED_BINARY_NAME), 0o755);
  writeFileSync(join(staging, "stamp"), stamp);
  rmSync(distDir, { recursive: true, force: true });
  renameSync(staging, distDir);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  fail(`unpacking failed: ${error instanceof Error ? error.message : error}`);
}
console.log(
  `[cloudflared] ${CLOUDFLARED_VERSION} ready at ${CLOUDFLARED_DIST_DIR}/${CLOUDFLARED_BINARY_NAME}`,
);
