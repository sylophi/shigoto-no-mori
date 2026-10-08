// Where a project's icon is, as the files and sources it looks at:
// every package root (the repo's top level, then each folder holding a
// package.json, shallowest first) is probed for the conventional icon
// files, then for a <link rel="icon"> href in the usual source files.

export const ICON_CANDIDATES = [
  // The root, the universal favicon convention.
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  // public/ for Vite, CRA, Next.js, Nuxt.
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  // static/ for Docusaurus, SvelteKit, Hugo, Jekyll.
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "static/img/logo.svg",
  "static/img/logo.png",
  "static/img/favicon.svg",
  "static/img/favicon.ico",
  // app/ for the Next.js App Router.
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "app/favicon.ico",
  "app/favicon.png",
  // src/ for a src layout, and Astro's src/assets.
  "src/favicon.svg",
  "src/favicon.ico",
  "src/assets/logo.svg",
  "src/assets/logo.png",
  "src/assets/icon.svg",
  "src/assets/icon.png",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  // assets/ for Electron Forge, Expo and the rest.
  "assets/icon.svg",
  "assets/icon.png",
  "assets/adaptive-icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  // Docs sites.
  "docs/.vitepress/public/logo.svg",
  "docs/.vitepress/public/favicon.svg",
  "docs/.vitepress/public/favicon.ico",
  // Mintlify.
  "logo/light.svg",
  "logo/dark.svg",
  "logo/light.png",
  "logo/dark.png",
  // Tauri.
  "src-tauri/icons/icon.svg",
  "src-tauri/icons/icon.png",
  "src-tauri/icons/icon.ico",
  // JetBrains' project marker.
  ".idea/icon.svg",
];

export const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

const LINK_TAG = /<link\b[^>]*>/gi;
const REL_HTML = /\brel=["'](?:icon|shortcut icon)["']/i;
const HREF_HTML = /\bhref=["']([^"'?]+)/i;
const REL_OBJECT = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const HREF_OBJECT = /\bhref\s*:\s*["']([^"'?]+)/i;

// The href of the first icon link: a <link> tag, or an object literal
// (a route's `links`) up to its closing brace.
export function iconHref(source: string): string | undefined {
  for (const [tag] of source.matchAll(LINK_TAG)) {
    if (REL_HTML.test(tag)) {
      const href = HREF_HTML.exec(tag)?.[1];
      if (href !== undefined) return href;
    }
  }
  for (const chunk of source.split("}")) {
    if (REL_OBJECT.test(chunk)) {
      const href = HREF_OBJECT.exec(chunk)?.[1];
      if (href !== undefined) return href;
    }
  }
  return undefined;
}

const depth = (dir: string) => dir.split("/").length - (dir === "" ? 1 : 0);

// The repo root ("") and every folder holding a package.json, by depth
// then name, so the root and the top-level packages win.
export function packageRoots(files: ReadonlyArray<string>): string[] {
  const roots = new Set([""]);
  for (const file of files) {
    if (file === "package.json") continue;
    if (file.endsWith("/package.json")) {
      roots.add(file.slice(0, -"/package.json".length));
    }
  }
  return [...roots].toSorted(
    (a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

// A relative path joined and cleaned as Go's path.Join does: `.` and
// empty segments dropped, `..` folded, no leading slash kept.
export function joinRelative(...parts: ReadonlyArray<string>): string {
  const out: string[] = [];
  for (const segment of parts.join("/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out.at(-1) !== "..") {
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mimeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const extension = dot > slash ? path.slice(dot) : "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}
