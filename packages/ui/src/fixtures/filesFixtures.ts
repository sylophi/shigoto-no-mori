// A posed worktree's files: the folder tree the files page and the
// mirror picker browse, what the viewer reads for its files, and the
// blobs a posed diff's image names. Pure data, served by bridge.ts.

// What the files page's viewer reads for a FAKE_TREE file: something
// the highlighter can dress by extension, the .env as the ignored file
// a peer with the grant still reads.
export function fakeFile(path: string) {
  const contents = FAKE_FILES[path];
  if (contents === undefined) return { kind: "missing" as const };
  return { kind: "text" as const, contents, size: contents.length };
}

// The two sides of FAKE_DIFF's icon.png (pullRequestFixtures.ts), by
// the blob ids its patch names. SVG drawn as an image, which is all the
// diff's preview sees.
export function fakeBlob(oid: string) {
  const svg = FAKE_BLOBS[oid];
  if (svg === undefined) return { kind: "missing" as const };
  return {
    kind: "media" as const,
    mime: "image/svg+xml",
    base64: btoa(svg),
    size: svg.length,
  };
}

const FAKE_BLOBS: Record<string, string> = {
  "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d": `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="56" fill="#9ca3af"/></svg>`,
  "5d6e7f8a9b0c1d2e3f405162738495a6b7c8d9e0": `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect x="8" y="8" width="112" height="112" rx="28" fill="#16a34a"/><path d="M40 84c0-28 20-44 48-44 0 28-16 48-44 48" fill="#bbf7d0"/></svg>`,
};

const FAKE_FILES: Record<string, string> = {
  ".env": "DATABASE_URL=postgres://localhost:5432/lab\n",
  ".gitignore": "node_modules\ndist\n.env*\n",
  "package.json": `{
  "name": "lab",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build" }
}
`,
  "README.md": "# Lab\n\nA posed checkout for the files page.\n",
  "src/index.ts": `import { render } from "./components/render";

export function main(root: HTMLElement): void {
  render(root, { greeting: "hello" });
}
`,
};

// The folder tree the mirror picker browses, one posed worktree.
export const FAKE_TREE: Record<
  string,
  { name: string; isDirectory: boolean; ignored: boolean }[]
> = {
  "": [
    { name: ".cache", isDirectory: true, ignored: true },
    { name: ".turbo", isDirectory: true, ignored: true },
    { name: ".vite", isDirectory: true, ignored: true },
    { name: "coverage", isDirectory: true, ignored: true },
    { name: "dist", isDirectory: true, ignored: true },
    { name: "dist-cli", isDirectory: true, ignored: true },
    { name: "node_modules", isDirectory: true, ignored: true },
    { name: "out", isDirectory: true, ignored: true },
    { name: "playwright-report", isDirectory: true, ignored: true },
    { name: "src", isDirectory: true, ignored: false },
    { name: "test-results", isDirectory: true, ignored: true },
    { name: "tmp", isDirectory: true, ignored: true },
    { name: ".env", isDirectory: false, ignored: true },
    { name: ".env.local", isDirectory: false, ignored: true },
    { name: ".eslintcache", isDirectory: false, ignored: true },
    { name: ".gitignore", isDirectory: false, ignored: false },
    { name: "package.json", isDirectory: false, ignored: false },
    { name: "README.md", isDirectory: false, ignored: false },
    { name: "tsconfig.tsbuildinfo", isDirectory: false, ignored: true },
  ],
  src: [
    { name: "components", isDirectory: true, ignored: false },
    { name: "generated", isDirectory: true, ignored: true },
    { name: "index.ts", isDirectory: false, ignored: false },
  ],
  "src/generated": [{ name: "schema.ts", isDirectory: false, ignored: true }],
  dist: [{ name: "bundle.js", isDirectory: false, ignored: true }],
};
