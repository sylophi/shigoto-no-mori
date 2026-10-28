// A pinned download into one of the app's dist folders, as
// fetch-cloudflared.mts and fetch-node.mts take theirs: kept while its
// stamp matches, else fetched and refused unless its sha256 is the one
// committed, then unpacked aside and swapped in whole, so a failure
// keeps the copy already there. Nothing it fetches is run.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Whether it was there already.
export async function fetchPinned(pinned: {
  readonly label: string;
  readonly distDir: string;
  readonly binaryName: string;
  readonly stamp: string;
  readonly url: string;
  readonly name: string;
  readonly sha256: string;
  // What goes into `staging` from the download: the binary, and
  // whatever ships beside it.
  readonly unpack: (bytes: Buffer, staging: string) => void;
}): Promise<boolean> {
  const stampPath = join(pinned.distDir, "stamp");
  if (
    existsSync(join(pinned.distDir, pinned.binaryName)) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8") === pinned.stamp
  ) {
    return true;
  }
  console.log(`[${pinned.label}] fetching ${pinned.url}`);
  const response = await fetch(pinned.url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== pinned.sha256) {
    throw new Error(
      `sha256 mismatch for ${pinned.name}: expected ${pinned.sha256}, got ${digest}`,
    );
  }
  const staging = `${pinned.distDir}.tmp`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    pinned.unpack(bytes, staging);
    writeFileSync(join(staging, "stamp"), pinned.stamp);
    rmSync(pinned.distDir, { recursive: true, force: true });
    renameSync(staging, pinned.distDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return false;
}
