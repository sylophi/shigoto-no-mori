// A posed worktree's files: the folder tree the files page and the
// mirror picker browse, and what the viewer reads for its files. Pure
// data, served by bridge.ts.

// What the files page's viewer reads for a FAKE_TREE file: something
// the highlighter can dress by extension, the .env as the ignored file
// a peer with the grant still reads.
export function fakeFile(path: string) {
  const contents = FAKE_FILES[path];
  if (contents === undefined) return { kind: "missing" as const };
  return { kind: "text" as const, contents, size: contents.length };
}

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
