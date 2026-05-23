/* oxlint-disable no-await-in-loop -- candidate sweeps are intentionally
   serial: the first match in priority order wins, so parallelising would
   either do unnecessary work or pick a lower-priority winner. */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectIcon } from "@shared/schemas";
import { atomicWriteJson } from "./jsonFile";
import { isENOENT, shigomoriRoot } from "./paths";

// Icon candidates per location bucket. Within each bucket .icns ranks
// first so Electron / macOS projects that ship a native icon win over
// any sibling raster fallback. Bucket priority roughly tracks how
// canonical each location is for "the project's primary icon":
// root → public/ → static/ → app/ → src/ → assets/ → docs sites →
// build artifacts.
const ICON_CANDIDATES = [
  // Root — the universal favicon convention.
  "favicon.icns",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",

  // public/ — Vite, CRA, Next.js, Nuxt.
  "public/favicon.icns",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",

  // static/ — Docusaurus, SvelteKit, Hugo, Jekyll.
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "static/img/logo.svg",
  "static/img/logo.png",
  "static/img/favicon.svg",
  "static/img/favicon.ico",

  // app/ — Next.js App Router (root layout).
  "app/icon.icns",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "app/favicon.ico",
  "app/favicon.png",

  // src/ — Vite/CRA/Next.js with src layout, plus Astro's src/assets.
  "src/favicon.icns",
  "src/favicon.svg",
  "src/favicon.ico",
  "src/assets/logo.svg",
  "src/assets/logo.png",
  "src/assets/icon.svg",
  "src/assets/icon.png",
  "src/app/icon.icns",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",

  // assets/ — Electron Forge, Expo, generic.
  "assets/icon.icns",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/adaptive-icon.png",
  "assets/logo.icns",
  "assets/logo.svg",
  "assets/logo.png",

  // Docs-site conventions.
  "docs/.vitepress/public/logo.svg",
  "docs/.vitepress/public/favicon.svg",
  "docs/.vitepress/public/favicon.ico",

  // Mintlify — no theme awareness yet, so pick the light variant first
  // (looks correct in shigomori's light theme; will look poor in dark
  // until we plumb theme through the resolver).
  "logo/light.svg",
  "logo/dark.svg",
  "logo/light.png",
  "logo/dark.png",

  // Tauri.
  "src-tauri/icons/icon.icns",
  "src-tauri/icons/icon.svg",
  "src-tauri/icons/icon.png",
  "src-tauri/icons/icon.ico",

  // electron-builder / electron-forge build artifacts.
  "build/icon.icns",
  "build/icons/icon.icns",
  "resources/icon.icns",

  // JetBrains project marker.
  ".idea/icon.svg",
] as const;

// Source files that may declare an icon via <link rel="icon" href="..."> or
// the object form used by route-config files (TanStack Start, Remix, etc.).
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
  return (
    source.match(LINK_ICON_HTML_RE)?.[1] ??
    source.match(LINK_ICON_OBJ_RE)?.[1] ??
    null
  );
}

// Defense against a malicious source file pointing href="../.." outside
// the project. Path-string only, not realpath — matches t3code's
// trade-off; symlinks within the project are fine.
function isPathWithinProject(
  projectCwd: string,
  candidatePath: string,
): boolean {
  const rel = relative(resolve(projectCwd), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function findFirstExisting(
  projectCwd: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!isPathWithinProject(projectCwd, candidate)) continue;
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function resolveIconHref(projectCwd: string, href: string): string[] {
  const clean = href.replace(/^\//, "");
  return [join(projectCwd, "public", clean), join(projectCwd, clean)];
}

async function resolveIconPath(cwd: string): Promise<string | null> {
  for (const candidate of ICON_CANDIDATES) {
    const resolved = join(cwd, candidate);
    // Candidates are always within the project (built by joining cwd +
    // a literal), so the containment check is unnecessary here.
    if (await fileExists(resolved)) return resolved;
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    let source: string;
    try {
      source = await readFile(join(cwd, sourceFile), "utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href) continue;
    const existing = await findFirstExisting(cwd, resolveIconHref(cwd, href));
    if (existing) return existing;
  }

  return null;
}

// ─── ICNS decoder ─────────────────────────────────────────────────────────
//
// ICNS layout: 8-byte file header ("icns" + big-endian total length),
// then a stream of chunks where each chunk is 4-byte OSType + 4-byte
// big-endian length (including the 8-byte header) + payload.
//
// Modern chunks (ic07+, icp4/5/6, ic11..ic14) carry PNG payloads
// directly. The largest types (ic08..ic10) can also carry JPEG-2000; we
// detect PNG by the magic and skip JPEG-2000. Older types
// (is32/il32/ih32/it32 + their *8mk alpha masks) are raw 24-bit RGB and
// require mask compositing — not worth supporting since modern .icns
// files almost always include a PNG variant.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIME_PNG = "image/png";

// PNG-bearing ICNS chunk types in our preferred extraction order: smallest
// variant still crisp on retina at sidebar sizes (14px @4x ≈ 56px), then
// larger sizes as fallback, then sub-retina as last resort.
const ICNS_PNG_CANDIDATES: ReadonlyArray<readonly [string, number]> = [
  ["icp6", 64],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
  ["icp5", 32],
  ["icp4", 16],
];

interface IcnsChunk {
  type: string;
  payload: Buffer;
}

function parseIcnsChunks(bytes: Buffer): IcnsChunk[] {
  if (bytes.length < 8 || bytes.toString("ascii", 0, 4) !== "icns") return [];
  const chunks: IcnsChunk[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) break;
    chunks.push({ type, payload: bytes.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return chunks;
}

function extractPngFromIcns(bytes: Buffer): Buffer | null {
  const chunks = parseIcnsChunks(bytes);
  if (chunks.length === 0) return null;
  const byType = new Map(chunks.map((c) => [c.type, c.payload]));
  for (const [type] of ICNS_PNG_CANDIDATES) {
    const payload = byType.get(type);
    if (!payload || payload.length < PNG_MAGIC.length) continue;
    if (payload.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return payload;
  }
  return null;
}

// ─── Cache ────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": MIME_PNG,
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // ICNS gets decoded to PNG before serving, so the on-wire mime is PNG.
  ".icns": MIME_PNG,
};

function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function isIcnsPath(path: string): boolean {
  return path.toLowerCase().endsWith(".icns");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface IconCacheEntry {
  sourcePath: string;
  sourceHash: string;
  // mtime+size let revalidation short-circuit the full read+hash when
  // the source file hasn't been touched — the common steady-state path.
  sourceSize: number;
  sourceMtimeMs: number;
  // Only set for ICNS: absolute path to the decoded PNG we stashed in
  // the cache dir. The IPC reads bytes from here instead of sourcePath.
  decodedPath?: string;
  mime: string;
  updatedAt: number;
}

// `null` means "we looked and there's no icon" — persisted so a cold
// launch doesn't repeat the candidate sweep for icon-less projects.
type CachedResult = IconCacheEntry | null;

const cacheDir = (): string => join(shigomoriRoot(), "iconCache");
const indexPath = (): string => join(cacheDir(), "index.json");
const decodedPathFor = (hash: string): string =>
  join(cacheDir(), `${hash}.png`);

let memoryCache: Map<string, CachedResult> | null = null;
let loadPromise: Promise<Map<string, CachedResult>> | null = null;

async function loadCache(): Promise<Map<string, CachedResult>> {
  if (memoryCache) return memoryCache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await readFile(indexPath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, CachedResult>;
      memoryCache = new Map(Object.entries(parsed));
    } catch (error) {
      // A corrupt or unreadable index shouldn't take the app down — we
      // can always rebuild it from disk on demand.
      if (!isENOENT(error)) {
        console.warn(
          "[icon-cache] failed to read index, starting fresh:",
          error,
        );
      }
      memoryCache = new Map();
    }
    return memoryCache;
  })();
  return loadPromise;
}

async function persistCache(map: Map<string, CachedResult>): Promise<void> {
  await atomicWriteJson(indexPath(), Object.fromEntries(map));
}

async function decodeIcnsToCache(
  bytes: Buffer,
  hash: string,
): Promise<string | null> {
  const png = extractPngFromIcns(bytes);
  if (!png) return null;
  await mkdir(cacheDir(), { recursive: true });
  const dest = decodedPathFor(hash);
  await writeFile(dest, png);
  return dest;
}

async function buildEntry(sourcePath: string): Promise<IconCacheEntry | null> {
  let sourceBytes: Buffer;
  let st: Stats;
  try {
    [sourceBytes, st] = await Promise.all([
      readFile(sourcePath),
      stat(sourcePath),
    ]);
  } catch {
    return null;
  }
  const sourceHash = sha256(sourceBytes);
  const mime = mimeForPath(sourcePath);

  if (isIcnsPath(sourcePath)) {
    const decoded = await decodeIcnsToCache(sourceBytes, sourceHash);
    if (!decoded) return null;
    return {
      sourcePath,
      sourceHash,
      sourceSize: st.size,
      sourceMtimeMs: st.mtimeMs,
      decodedPath: decoded,
      mime,
      updatedAt: Date.now(),
    };
  }

  return {
    sourcePath,
    sourceHash,
    sourceSize: st.size,
    sourceMtimeMs: st.mtimeMs,
    mime,
    updatedAt: Date.now(),
  };
}

async function dropDecoded(entry: CachedResult): Promise<void> {
  if (!entry?.decodedPath) return;
  try {
    await unlink(entry.decodedPath);
  } catch {
    // already gone — losing the decoded artifact is recoverable; we
    // just re-decode from the source on the next IPC.
  }
}

// Revalidate a cached entry and return both the (possibly refreshed)
// entry and the bytes ready to base64. The fast path is a single stat
// plus one read of whatever file we'll serve — no source-file hash,
// no double-read. Returns null when the source has disappeared, which
// the caller treats as a signal to re-run the resolver.
async function revalidateAndRead(
  entry: IconCacheEntry,
): Promise<{ entry: IconCacheEntry; bytes: Buffer; dirty: boolean } | null> {
  const st = await statOrNull(entry.sourcePath);
  if (!st) return null;

  const statMatches =
    st.size === entry.sourceSize && st.mtimeMs === entry.sourceMtimeMs;
  const decodedReady =
    !entry.decodedPath || (await fileExists(entry.decodedPath));

  if (statMatches && decodedReady) {
    const bytes = await readFile(entry.decodedPath ?? entry.sourcePath);
    return { entry, bytes, dirty: false };
  }

  // Slow path: stat differs OR the decoded artifact was wiped. Read +
  // hash to tell a content change from a touch-only edit.
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(entry.sourcePath);
  } catch {
    return null;
  }
  const hash = sha256(sourceBytes);
  if (hash === entry.sourceHash) {
    // Content unchanged; refresh stat fields (and re-decode if the
    // ICNS artifact was missing).
    let decoded = entry.decodedPath;
    if (entry.decodedPath && !decodedReady) {
      const re = await decodeIcnsToCache(sourceBytes, hash);
      if (!re) return null;
      decoded = re;
    }
    const refreshed: IconCacheEntry = {
      ...entry,
      sourceSize: st.size,
      sourceMtimeMs: st.mtimeMs,
      decodedPath: decoded,
      updatedAt: Date.now(),
    };
    const bytes = decoded ? await readFile(decoded) : sourceBytes;
    return { entry: refreshed, bytes, dirty: true };
  }

  // Content changed — full rebuild.
  const rebuilt = await buildEntry(entry.sourcePath);
  if (!rebuilt) return null;
  const bytes = await readFile(rebuilt.decodedPath ?? rebuilt.sourcePath);
  return { entry: rebuilt, bytes, dirty: true };
}

// One in-flight resolution per project path so the parallel IPC
// fan-out from the sidebar's first render doesn't race itself.
const inflight = new Map<string, Promise<ProjectIcon | null>>();

export async function readProjectIcon(
  projectPath: string,
): Promise<ProjectIcon | null> {
  const pending = inflight.get(projectPath);
  if (pending) return pending;
  const promise = readProjectIconInner(projectPath).finally(() => {
    inflight.delete(projectPath);
  });
  inflight.set(projectPath, promise);
  return promise;
}

async function readProjectIconInner(
  projectPath: string,
): Promise<ProjectIcon | null> {
  const cache = await loadCache();
  const cached = cache.get(projectPath);

  if (cached) {
    const revalidated = await revalidateAndRead(cached);
    if (revalidated) {
      if (revalidated.dirty) {
        if (
          cached.decodedPath &&
          cached.decodedPath !== revalidated.entry.decodedPath
        ) {
          await dropDecoded(cached);
        }
        cache.set(projectPath, revalidated.entry);
        await persistCache(cache);
      }
      return {
        mime: revalidated.entry.mime,
        base64: revalidated.bytes.toString("base64"),
      };
    }
    // Source vanished — drop the decoded artifact and fall through to
    // re-resolve in case the project now has a different icon.
    await dropDecoded(cached);
  }

  const resolved = await resolveIconPath(projectPath);
  if (!resolved) {
    // Skip the write when we're just reaffirming an existing null entry.
    if (cached !== null) {
      cache.set(projectPath, null);
      await persistCache(cache);
    }
    return null;
  }

  const entry = await buildEntry(resolved);
  cache.set(projectPath, entry);
  await persistCache(cache);
  if (!entry) return null;
  const bytes = await readFile(entry.decodedPath ?? entry.sourcePath);
  return { mime: entry.mime, base64: bytes.toString("base64") };
}

export async function forgetProjectIcon(projectPath: string): Promise<void> {
  const cache = await loadCache();
  const existing = cache.get(projectPath);
  if (existing === undefined) return;
  await dropDecoded(existing);
  cache.delete(projectPath);
  await persistCache(cache);
}
