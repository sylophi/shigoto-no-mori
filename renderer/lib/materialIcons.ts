import { createExternalStore, type ExternalStore } from "@/store/externalStore";

type LightVariants = {
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
};

export type IconManifest = {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
  light?: LightVariants;
  file: string;
  folder: string;
  folderExpanded: string;
};

// The manifest is ~440 KB of JSON that only the file pickers read, so
// it is its own chunk, fetched when the first icon mounts, instead of
// part of what every window (and every web page load) downloads at
// boot. A store rather than a promise so MaterialIcon paints the
// moment it lands.
const loaded = createExternalStore<IconManifest | null>(null);
let requested = false;
let attempts = 0;
const MANIFEST_ATTEMPTS = 5;
const MANIFEST_RETRY_MS = 5_000;

function requestManifest(): void {
  if (requested) return;
  requested = true;
  import("material-icon-theme/dist/material-icons.json")
    .then((module) => {
      loaded.publish(module.default as IconManifest);
    })
    .catch(() => {
      // A failed chunk fetch (offline, mostly). The icons already
      // mounted subscribed once and will not ask again, so this does,
      // a few times: a chunk a deploy removed never comes back.
      requested = false;
      attempts += 1;
      if (attempts < MANIFEST_ATTEMPTS) {
        setTimeout(requestManifest, MANIFEST_RETRY_MS);
      }
    });
}

// Null until the manifest lands. Subscribing is what asks for it.
export const iconManifestStore: ExternalStore<IconManifest | null> = {
  ...loaded,
  subscribe(listener) {
    requestManifest();
    return loaded.subscribe(listener);
  },
};

// VS Code resolves bare extensions through its language registry rather
// than the icon theme's fileExtensions map. The manifest reflects that,
// so .ts/.js/.md/... aren't direct keys. We bridge to the manifest's
// languageIds table via this small subset of VS Code's built-in
// associations (https://code.visualstudio.com/docs/languages/identifiers).
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
};

// Strip a single trailing 'separator-suffix' and keep walking down to find
// the most specific extension the manifest knows. For 'foo.test.ts' we try
// 'test.ts' first, then 'ts'. Matches VS Code's resolution order.
function* extensionsOf(name: string): Generator<string> {
  const lower = name.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === ".") {
      const ext = lower.slice(i + 1);
      if (ext.length > 0) yield ext;
    }
  }
}

const EMPTY: Record<string, string> = Object.freeze({});

export function resolveFileIcon(
  m: IconManifest,
  name: string,
  light: boolean,
): string {
  const lower = name.toLowerCase();
  const lightFileNames = light ? (m.light?.fileNames ?? EMPTY) : EMPTY;
  const lightFileExts = light ? (m.light?.fileExtensions ?? EMPTY) : EMPTY;
  const lightLangIds = light ? (m.light?.languageIds ?? EMPTY) : EMPTY;

  const byName = lightFileNames[lower] ?? m.fileNames[lower];
  if (byName) return byName;

  for (const ext of extensionsOf(lower)) {
    const byExt = lightFileExts[ext] ?? m.fileExtensions[ext];
    if (byExt) return byExt;
    const lang = EXTENSION_TO_LANGUAGE[ext];
    if (lang) {
      const byLang = lightLangIds[lang] ?? m.languageIds[lang];
      if (byLang) return byLang;
    }
  }

  return m.file;
}

export function resolveFolderIcon(
  m: IconManifest,
  name: string,
  expanded: boolean,
): string {
  const lower = name.toLowerCase();
  const map = expanded ? m.folderNamesExpanded : m.folderNames;
  return map[lower] ?? (expanded ? m.folderExpanded : m.folder);
}

// Icons live in public/material-icons/ (synced from node_modules by
// scripts/copy-material-icons.mjs). Anchoring at `import.meta.env.BASE_URL`
// matters for packaged Electron: electron-forge's Vite plugin builds with
// `base: './'` so the renderer works under file://, and a leading-slash
// path would resolve to the filesystem root instead. In dev BASE_URL is
// "/" so the URL is "/material-icons/<name>.svg" as before.
export function iconUrl(name: string): string {
  return `${import.meta.env.BASE_URL}material-icons/${name}.svg`;
}
