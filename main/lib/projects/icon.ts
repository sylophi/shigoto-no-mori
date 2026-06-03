/* oxlint-disable no-await-in-loop -- candidate sweeps are intentionally
   serial: the first match in priority order wins, so parallelising would
   either do unnecessary work or pick a lower-priority winner. */
/* react-doctor-disable react-doctor/async-await-in-loop -- same reason as oxlint above. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { ProjectIcon } from "@shared/schemas";
import { listProjectFiles } from "../git/files";
import { atomicWriteJson } from "../util/jsonFile";
import { isENOENT, shigomoriRoot } from "../util/paths";

// Icon candidates per location bucket. Bucket priority roughly tracks
// how canonical each location is for "the project's primary icon":
// root → public/ → static/ → app/ → src/ → assets/ → docs sites →
// build artifacts.
const ICON_CANDIDATES = [
  // Root — the universal favicon convention.
  "favicon.svg",
  "favicon.ico",
  "favicon.png",

  // public/ — Vite, CRA, Next.js, Nuxt.
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
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "app/favicon.ico",
  "app/favicon.png",

  // src/ — Vite/CRA/Next.js with src layout, plus Astro's src/assets.
  "src/favicon.svg",
  "src/favicon.ico",
  "src/assets/logo.svg",
  "src/assets/logo.png",
  "src/assets/icon.svg",
  "src/assets/icon.png",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",

  // assets/ — Electron Forge, Expo, generic.
  "assets/icon.svg",
  "assets/icon.png",
  "assets/adaptive-icon.png",
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
  "src-tauri/icons/icon.svg",
  "src-tauri/icons/icon.png",
  "src-tauri/icons/icon.ico",

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
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function resolveIconHref(projectCwd: string, href: string): string[] {
  const clean = href.replace(/^\//, "");
  return [join(projectCwd, "public", clean), join(projectCwd, clean)];
}

// ─── Git-driven resolution ──────────────────────────────────────────────────
//
// The primary resolver probes the existing candidate/source patterns at every
// *package root* in the repo — the top level plus each package.json directory
// — over the set of files git can see (tracked plus untracked-but-not-ignored).
// Driving off that set keeps build output (dist/, .next/) and node_modules
// invisible while still surfacing an uncommitted favicon. It also descends into
// monorepo subpackages (a web app in web/ or apps/web/ resolves its favicon
// just like one at the root) while anchoring on package roots, so a vendored
// asset buried under, say, convex/.agents/skills/foo/assets/icon.svg is never
// mistaken for the project icon: that directory isn't a package, so
// "assets/icon.svg" is only probed where a package.json actually lives.

function posixDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function posixJoin(dir: string, rest: string): string {
  return dir ? `${dir}/${rest}` : rest;
}

// Repo root ("") plus every directory holding a package.json, shallowest
// first so the root and top-level packages win ties.
function packageRoots(files: readonly string[]): string[] {
  const roots = new Set<string>([""]);
  for (const file of files) {
    if (file === "package.json" || file.endsWith("/package.json")) {
      roots.add(posixDir(file));
    }
  }
  // Shallowest first; the empty-string root sorts ahead of everything else.
  return [...roots].toSorted(
    (a, b) =>
      a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0),
  );
}

// Resolve a <link rel="icon" href> against a package root (and its public/
// dir), returning the listed path it points at. Candidates are normalised so
// "./icon.svg" or "a/../b" canonicalise before the membership test; an href
// that escapes the repo normalises to a path the set never contains, so
// traversal is rejected for free.
function resolveIconHrefInFiles(
  root: string,
  href: string,
  files: ReadonlySet<string>,
): string | null {
  const clean = href.replace(/^\//, "");
  const candidates = [
    posix.normalize(posixJoin(root, `public/${clean}`)),
    posix.normalize(posixJoin(root, clean)),
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

// The historical two-phase scan (conventional files, then <link rel="icon">
// in a source file), scoped to a single package root. `root === ""` is the
// repo top level and reproduces the pre-descent behaviour exactly. A path in
// `files` is git's view, so a file staged-then-deleted from the working tree
// still appears; each match is confirmed on disk before we commit to it, so a
// phantom entry can't shadow a lower-priority icon that does exist.
async function resolveIconAtRoot(
  cwd: string,
  root: string,
  files: ReadonlySet<string>,
): Promise<string | null> {
  for (const candidate of ICON_CANDIDATES) {
    const rel = posixJoin(root, candidate);
    if (!files.has(rel)) continue;
    const abs = join(cwd, rel);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
    if (await fileExists(abs)) return abs;
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const rel = posixJoin(root, sourceFile);
    if (!files.has(rel)) continue;
    let source: string;
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
      source = await readFile(join(cwd, rel), "utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href) continue;
    const resolved = resolveIconHrefInFiles(root, href, files);
    if (!resolved) continue;
    const abs = join(cwd, resolved);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
    if (await fileExists(abs)) return abs;
  }

  return null;
}

async function resolveIconPath(cwd: string): Promise<string | null> {
  const files = await listProjectFiles(cwd);
  // git unavailable or an empty working tree: fall back to a top-level
  // filesystem scan.
  if (files.length === 0) return resolveIconPathShallow(cwd);

  const fileSet = new Set(files);
  // Repo root first — so any project that resolved before resolves to the
  // identical icon — then each deeper package root, nearest first. Descent is
  // pure addition: it only fires where the top-level scan came up empty.
  for (const root of packageRoots(files)) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- nearest package root wins; first hit short-circuits
    const resolved = await resolveIconAtRoot(cwd, root, fileSet);
    if (resolved) return resolved;
  }

  return null;
}

// Filesystem fallback for when git lists nothing (git unavailable, or an
// empty working tree). Mirrors the historical top-level-only behaviour.
async function resolveIconPathShallow(cwd: string): Promise<string | null> {
  for (const candidate of ICON_CANDIDATES) {
    const resolved = join(cwd, candidate);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
    if (await fileExists(resolved)) return resolved;
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    let source: string;
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
      source = await readFile(join(cwd, sourceFile), "utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href) continue;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters; first match wins
    const existing = await findFirstExisting(cwd, resolveIconHref(cwd, href));
    if (existing) return existing;
  }

  return null;
}

// ─── Cache ────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface IconCacheEntry {
  sourcePath: string;
  sourceHash: string;
  // mtime + size let revalidation short-circuit the full read+hash when
  // the source file hasn't been touched — the common steady-state path.
  sourceSize: number;
  sourceMtimeMs: number;
  mime: string;
  updatedAt: number;
}

// We don't persist "no icon" results. Re-resolving an icon-less project
// is cheap (~50 stats on SSD) and React Query memoizes the null per
// session; persisting it would block users who add an icon to an
// existing project from ever seeing it without a manual cache reset.
const indexPath = (): string =>
  join(shigomoriRoot(), "iconCache", "index.json");

let memoryCache: Map<string, IconCacheEntry> | null = null;
let loadPromise: Promise<Map<string, IconCacheEntry>> | null = null;

async function loadCache(): Promise<Map<string, IconCacheEntry>> {
  if (memoryCache) return memoryCache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await readFile(indexPath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, IconCacheEntry>;
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

// Coalesce parallel persists: a single in-flight write covers any
// number of additional callers because they all mutate the shared
// memoryCache before we serialize. Without this, the fan-out of N
// parallel IPCs from the sidebar's first render races itself on the
// index.json tmp + rename and surfaces ENOENT.
//
// Errors are logged and swallowed inside the loop because every
// coalesced caller awaits the same promise: an inner-loop rejection
// would otherwise propagate to callers whose own mutation already
// landed on disk in an earlier iteration. The next persist gets a
// fresh shot anyway.
let persistInFlight: Promise<void> | null = null;
let persistPending = false;

function persistCache(map: Map<string, IconCacheEntry>): Promise<void> {
  if (persistInFlight) {
    persistPending = true;
    return persistInFlight;
  }
  persistInFlight = (async () => {
    try {
      do {
        persistPending = false;
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- do/while coalesces concurrent persists into one in-flight write
          await atomicWriteJson(indexPath(), Object.fromEntries(map));
        } catch (error) {
          console.warn("[icon-cache] failed to persist index:", error);
        }
      } while (persistPending);
    } finally {
      persistInFlight = null;
    }
  })();
  return persistInFlight;
}

async function buildEntry(
  sourcePath: string,
): Promise<{ entry: IconCacheEntry; bytes: Buffer } | null> {
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
  return {
    entry: {
      sourcePath,
      sourceHash: sha256(sourceBytes),
      sourceSize: st.size,
      sourceMtimeMs: st.mtimeMs,
      mime: mimeForPath(sourcePath),
      updatedAt: Date.now(),
    },
    bytes: sourceBytes,
  };
}

// Revalidate a cached entry and return both the (possibly refreshed)
// entry and the source bytes ready to base64. Fast path is a single
// stat plus one read of the source — no hash, no double-read. Returns
// null when the source has disappeared, signalling the caller to
// re-run the resolver.
async function revalidateAndRead(
  entry: IconCacheEntry,
): Promise<{ entry: IconCacheEntry; bytes: Buffer; dirty: boolean } | null> {
  const st = await statOrNull(entry.sourcePath);
  if (!st) return null;

  if (st.size === entry.sourceSize && st.mtimeMs === entry.sourceMtimeMs) {
    const bytes = await readFile(entry.sourcePath);
    return { entry, bytes, dirty: false };
  }

  // Stat differs — read + hash to tell a content change from a
  // touch-only edit.
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(entry.sourcePath);
  } catch {
    return null;
  }
  const hash = sha256(sourceBytes);
  if (hash === entry.sourceHash) {
    return {
      entry: {
        ...entry,
        sourceSize: st.size,
        sourceMtimeMs: st.mtimeMs,
        updatedAt: Date.now(),
      },
      bytes: sourceBytes,
      dirty: true,
    };
  }

  return {
    entry: {
      sourcePath: entry.sourcePath,
      sourceHash: hash,
      sourceSize: st.size,
      sourceMtimeMs: st.mtimeMs,
      mime: entry.mime,
      updatedAt: Date.now(),
    },
    bytes: sourceBytes,
    dirty: true,
  };
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
        cache.set(projectPath, revalidated.entry);
        await persistCache(cache);
      }
      return {
        mime: revalidated.entry.mime,
        base64: revalidated.bytes.toString("base64"),
      };
    }
    // Source vanished — drop the stale entry and fall through to
    // re-resolve in case the project now has a different icon.
    cache.delete(projectPath);
    await persistCache(cache);
  }

  const resolved = await resolveIconPath(projectPath);
  if (!resolved) return null;

  const built = await buildEntry(resolved);
  if (!built) return null;
  cache.set(projectPath, built.entry);
  await persistCache(cache);
  return { mime: built.entry.mime, base64: built.bytes.toString("base64") };
}

export async function forgetProjectIcon(projectPath: string): Promise<void> {
  const cache = await loadCache();
  if (!cache.has(projectPath)) return;
  cache.delete(projectPath);
  await persistCache(cache);
}
