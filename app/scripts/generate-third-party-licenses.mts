#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

import {
  CLOUDFLARED_LICENSE,
  CLOUDFLARED_REPOSITORY,
  CLOUDFLARED_VERSION,
} from "../shared/packaging/cloudflaredDist.mts";

type LicenseInfo = {
  name?: string;
  version?: string;
  licenses?: string | string[];
  repository?: string;
  publisher?: string;
  url?: string;
  licenseFile?: string;
  licenseText?: string;
  copyright?: string;
};

type LicenseEntry = Required<LicenseInfo>;

const require = createRequire(import.meta.url);

const OUT_DIR = join(appRoot, "resources", "licenses");
const JSON_OUT = join(OUT_DIR, "third-party-licenses.json");
const TEXT_OUT = join(OUT_DIR, "THIRD-PARTY-LICENSES.txt");
const CHECK = process.argv.includes("--check");

const execFileP = promisify(execFile);

// The Bun the release workflow compiles the terminal sm with
// (.github/workflows/release.yml, setup-bun).
const BUN_VERSION = "1.4.0";

// Whose production dependencies ship: the app's, the ui package's, which
// the renderer bundles, and the terminal sm's, which Bun compiles into
// its binary.
const NPM_ROOTS = [
  appRoot,
  join(repoRoot, "packages", "ui"),
  join(repoRoot, "packages", "cli"),
];

// The Go modules whose binaries ship inside the app (the file-sync
// engine and the darwin helper), each walked for the modules
// ACTUALLY LINKED into its default build: `go list -deps` over the main
// package, with the default build tags, so a dependency reachable only
// through a build tag this project never sets (Mutagen's
// source-available parts behind `mutagensspl`) is neither compiled in
// nor listed.
const GO_MODULES = ["file-sync", "macfs"];

// License file names Go modules use, in lookup order.
const LICENSE_FILE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "COPYING",
  "COPYING.md",
  "LICENSE-MIT",
  "LICENSE.MIT",
];

// The SPDX id a license text reads as. Go modules carry no license
// metadata, only the text, so the id is recognized from it. An
// unrecognized text is reported as missing so a new dependency with an
// unexpected license gets looked at rather than shipped unlabeled.
function identifyLicense(text: string): string {
  const t = text.replace(/\s+/g, " ");
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Mozilla Public License,? (?:Version )?2\.0/i.test(t)) return "MPL-2.0";
  if (/\bISC License\b/i.test(t)) return "ISC";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (
    /Permission to use, copy, modify, and\/or distribute this software/i.test(t)
  )
    return "ISC";
  if (
    /This is free and unencumbered software released into the public domain/i.test(
      t,
    )
  )
    return "Unlicense";
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    if (/neither the name .* nor the names of .* contributors/i.test(t))
      return "BSD-3-Clause";
    return "BSD-2-Clause";
  }
  return "";
}

async function findLicenseFile(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const candidate of LICENSE_FILE_NAMES) {
    const hit = names.find((name) => name === candidate);
    if (hit !== undefined) return join(dir, hit);
  }
  // Case-insensitive fallback for the odd module.
  const loose = names.find((name) => /^(license|licence|copying)/i.test(name));
  return loose === undefined ? null : join(dir, loose);
}

function repositoryOf(modulePath: string): string {
  const m = /^(github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/]+)/.exec(
    modulePath,
  );
  if (m !== null) return `https://${m[1]}/${m[2]}/${m[3]}`;
  if (modulePath.startsWith("golang.org/x/")) {
    return `https://go.googlesource.com/${modulePath.slice("golang.org/x/".length)}`;
  }
  if (modulePath.startsWith("google.golang.org/protobuf")) {
    return "https://go.googlesource.com/protobuf";
  }
  if (modulePath.startsWith("k8s.io/")) {
    return `https://github.com/kubernetes/${modulePath.slice("k8s.io/".length).split("/")[0]}`;
  }
  return `https://${modulePath}`;
}

// Notes that belong beside a module's license text.
const GO_MODULE_NOTES: Record<string, string | undefined> = {
  "github.com/mutagen-io/mutagen":
    "MIT except for parts of the repository under the Server Side Public " +
    "License, which are gated behind the `mutagensspl` build tag. This " +
    "project never sets that tag, so none of that code is compiled into " +
    "the file-sync engine.",
};

async function goModuleEntries(moduleDir: string): Promise<LicenseEntry[]> {
  const { stdout } = await execFileP(
    "go",
    [
      "list",
      "-deps",
      "-f",
      "{{if and (not .Standard) .Module (not .Module.Main)}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}",
      ".",
    ],
    { cwd: join(repoRoot, moduleDir), maxBuffer: 16 * 1024 * 1024 },
  );
  const modules = new Map<
    string,
    { path: string; version: string; dir: string }
  >();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [path, version, dir] = line.split("\t");
    if (path === undefined || version === undefined || dir === undefined) {
      continue;
    }
    if (!modules.has(path)) modules.set(path, { path, version, dir });
  }
  return Promise.all(
    [...modules.values()].map(async ({ path, version, dir }) => {
      const licenseFile = await findLicenseFile(dir);
      const licenseText =
        licenseFile === null
          ? ""
          : (await readFile(licenseFile, "utf8")).trim();
      const note = GO_MODULE_NOTES[path];
      return normalizeEntry([
        `${path}@${version}`,
        {
          licenses:
            licenseText === ""
              ? "UNKNOWN"
              : identifyLicense(licenseText) || "UNKNOWN",
          repository: repositoryOf(path),
          // Relative to the module cache root, never a machine path.
          licenseFile:
            licenseFile === null
              ? ""
              : `go-module-cache/${relative(dirname(dir), licenseFile)}`,
          licenseText:
            note === undefined ? licenseText : `${note}\n\n${licenseText}`,
        },
      ]);
    }),
  );
}

type Listed = {
  version?: string;
  dependencies?: Record<string, Listed>;
  optionalDependencies?: Record<string, Listed>;
};

// Each root's production dependencies, every level down, as name@version:
// what pnpm resolved, the optional peers it installed among them
// included.
async function shippedPackages(): Promise<Set<string>> {
  const listings = await Promise.all(
    NPM_ROOTS.map((root) =>
      execFileP(
        "pnpm",
        [
          "--filter",
          `./${relative(repoRoot, root)}`,
          "list",
          "--prod",
          "--json",
          "--depth",
          "Infinity",
        ],
        { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 },
      ),
    ),
  );
  const shipped = new Set<string>();
  const walk = (deps: Record<string, Listed> | undefined) => {
    for (const [name, listed] of Object.entries(deps ?? {})) {
      const key = `${name}@${listed.version ?? ""}`;
      if (shipped.has(key)) continue;
      shipped.add(key);
      walk(listed.dependencies);
      walk(listed.optionalDependencies);
    }
  };
  for (const { stdout } of listings) {
    for (const project of JSON.parse(stdout) as Listed[]) {
      walk(project.dependencies);
      walk(project.optionalDependencies);
    }
  }
  return shipped;
}

type Manifest = {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string | { type?: string };
  licenses?: Array<string | { type?: string }>;
  repository?: string | { url?: string };
};

// Every installed copy by name@version, the first one found in a sorted
// walk of the hoisted trees. pnpm's own paths assume its isolated layout,
// which the hoisted linker (pnpm-workspace.yaml) does not use.
type Installed = { key: string; dir: string; manifest: Manifest };

async function installedPackages(): Promise<Map<string, Installed>> {
  // Every package under a node_modules folder, in the folder's sorted
  // order, each followed by what its own node_modules holds.
  const visit = async (modulesDir: string): Promise<Installed[]> => {
    const names = await readdir(modulesDir).catch((): string[] => []);
    const found = await Promise.all(
      names
        .toSorted()
        .filter((name) => !name.startsWith("."))
        .map(async (name): Promise<Installed[]> => {
          const dir = join(modulesDir, name);
          if (name.startsWith("@")) return visit(dir);
          // A workspace package is a link, and has no license to list.
          if (!(await lstat(dir)).isDirectory()) return [];
          const manifest = await readFile(join(dir, "package.json"), "utf8")
            .then((text) => JSON.parse(text) as Manifest)
            .catch(() => null);
          const nested = await visit(join(dir, "node_modules"));
          if (manifest?.name === undefined || manifest.version === undefined) {
            return nested;
          }
          nested.unshift({
            key: `${manifest.name}@${manifest.version}`,
            dir,
            manifest,
          });
          return nested;
        }),
    );
    return found.flat();
  };
  const trees = await Promise.all(
    [repoRoot, ...NPM_ROOTS].map((root) => visit(join(root, "node_modules"))),
  );
  const byKey = new Map<string, Installed>();
  for (const copy of trees.flat()) {
    if (!byKey.has(copy.key)) byKey.set(copy.key, copy);
  }
  return byKey;
}

// A repository field as a browsable URL.
function repositoryUrl(repository: Manifest["repository"]): string {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (raw === undefined) return "";
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (shorthand !== null) return `https://github.com/${shorthand[1]}`;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^http:\/\//, "https://")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

// The copyright lines of a license text, a template's placeholder
// ("copyright owner that is granting the License") left out.
function copyrightOf(licenseText: string): string {
  return licenseText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^copyright\s+(?:\(c\)|©|\d)/i.test(line))
    .join(" ");
}

const licenseName = (license: string | { type?: string } | undefined) =>
  typeof license === "string" ? license : (license?.type ?? "");

function licensesOf(manifest: Manifest, licenseText: string): string {
  const declared =
    licenseName(manifest.license) ||
    (manifest.licenses ?? []).map(licenseName).filter(Boolean).join(" OR ");
  if (declared !== "") return declared;
  return licenseText === ""
    ? "UNKNOWN"
    : identifyLicense(licenseText) || "UNKNOWN";
}

async function npmPackageEntries(): Promise<LicenseEntry[]> {
  const [shipped, installed] = await Promise.all([
    shippedPackages(),
    installedPackages(),
  ]);
  const copies = [...shipped]
    .map((key) => installed.get(key))
    // Listed by pnpm but not installed for this platform (another OS's
    // optional binary): it does not ship from here.
    .filter(
      (copy): copy is Installed =>
        copy !== undefined && copy.manifest.private !== true,
    );
  return Promise.all(
    copies.map(async ({ key, dir, manifest }) => {
      const licenseFile = await findLicenseFile(dir);
      const licenseText =
        licenseFile === null
          ? ""
          : (await readFile(licenseFile, "utf8")).trim();
      return normalizeEntry([
        key,
        {
          licenses: licensesOf(manifest, licenseText),
          repository: repositoryUrl(manifest.repository),
          licenseFile:
            licenseFile === null
              ? ""
              : `${manifest.name}/${relative(dir, licenseFile)}`,
          licenseText,
          copyright: copyrightOf(licenseText),
        },
      ]);
    }),
  );
}

function splitPackageKey(key: string): { name: string; version: string } {
  const versionSeparator = key.lastIndexOf("@");
  if (versionSeparator <= 0) {
    return { name: key, version: "" };
  }

  return {
    name: key.slice(0, versionSeparator),
    version: key.slice(versionSeparator + 1),
  };
}

function normalizeEntry([key, value]: [string, LicenseInfo]): LicenseEntry {
  const fromKey = splitPackageKey(key);
  return {
    name: value.name || fromKey.name,
    version: value.version || fromKey.version,
    licenses: value.licenses || "UNKNOWN",
    repository: value.repository || "",
    publisher: value.publisher || "",
    url: value.url || "",
    // Kept relative to the package itself, never a machine path.
    licenseFile: value.licenseFile || "",
    licenseText: (value.licenseText || "").trim(),
    copyright: value.copyright || "",
  };
}

// Binaries the packaged app ships beside its npm dependencies. Not npm
// packages, so pnpm cannot see them. Listed by hand from
// the same pinned metadata the fetch script reads, through the same
// normalizer as every npm entry so the record shape has one owner.
const BUNDLED_BINARIES = [
  // The runtime the terminal sm is compiled with (packages/cli), the
  // version the release workflow installs.
  normalizeEntry([
    `bun@${BUN_VERSION}`,
    {
      licenses: "MIT",
      repository: "https://github.com/oven-sh/bun",
      publisher: "Oven",
      licenseText:
        "MIT License. Bun statically links JavaScriptCore and WebKit's WTF " +
        "(LGPL-2.0), and other libraries under their own licenses. Full " +
        `text: https://github.com/oven-sh/bun/blob/bun-v${BUN_VERSION}/LICENSE.md`,
    },
  ]),
  normalizeEntry([
    `cloudflared@${CLOUDFLARED_VERSION}`,
    {
      licenses: CLOUDFLARED_LICENSE,
      repository: CLOUDFLARED_REPOSITORY,
      publisher: "Cloudflare, Inc.",
      licenseText: `Apache License 2.0. Full text: ${CLOUDFLARED_REPOSITORY}/blob/${CLOUDFLARED_VERSION}/LICENSE`,
    },
  ]),
];

// Data the engine and the app embed: the doubutsu worktree names, taken
// from Nookipedia's character lists (scripts/fetch-doubutsu-names.mts).
// The entry opens with the Animal Crossing notice the Settings page
// shows beside Village life (shared/acNotice.json), so the two never
// drift, then gives the CC BY-SA attribution.
const doubutsuSource: { retrieved: string; url: string; name: string } =
  require("../../packages/engine/src/data/doubutsu-names.json").source;
const acNotice: string = require("../shared/acNotice.json").notice;
const BUNDLED_DATA = [
  normalizeEntry([
    `doubutsu-names@${doubutsuSource.retrieved}`,
    {
      licenses: "CC-BY-SA-4.0",
      url: doubutsuSource.url,
      publisher: doubutsuSource.name,
      licenseText:
        `${acNotice} Character names from Nookipedia's Villagers and ` +
        "Special characters categories, by Nookipedia contributors, " +
        "licensed under Creative Commons Attribution-ShareAlike 4.0 " +
        "International. Changed: turned into kebab-case worktree names. " +
        "Full text: https://creativecommons.org/licenses/by-sa/4.0/legalcode",
    },
  ]),
  // The terminal's fallback face for Nerd Font icons
  // (packages/ui/src/styles/fonts/SymbolsNerdFontMono-Regular.woff2), from the
  // project's NerdFontsSymbolsOnly release, its TTF compressed to woff2.
  // The glyphs come from icon sets under their own licenses, which the
  // release's README lists.
  normalizeEntry([
    "symbols-nerd-font-mono@3.5.1",
    {
      licenses: "MIT AND CC-BY-4.0 AND Apache-2.0 AND OFL-1.1 AND Unlicense",
      repository: "https://github.com/ryanoasis/nerd-fonts",
      publisher: "Ryan L McIntyre",
      licenseText:
        readFileSync(
          join(
            repoRoot,
            "packages",
            "ui",
            "src",
            "styles",
            "fonts",
            "SymbolsNerdFontMono-LICENSE",
          ),
          "utf8",
        ) +
        "\nThe glyphs come from these icon sets: Codicons and Font Awesome " +
        "(CC BY 4.0), Material Design Icons (Apache 2.0), Pomicons and " +
        "Weather Icons (OFL 1.1), Font Logos (Unlicense), and Devicons, " +
        "Font Awesome Extension, Octicons, Seti UI, Powerline Symbols, " +
        "Powerline Extra Symbols, Power Symbols IEC and Hack's extra glyphs " +
        "(MIT). Changed: the TTF compressed to woff2. Details: " +
        "https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1",
    },
  ]),
  // tmux's launcher icon (packages/ui/src/app-icons/tmux.png), its 128px logo
  // icon as published, unchanged.
  normalizeEntry([
    "tmux-logo@3b10392",
    {
      licenses: "ISC",
      repository: "https://github.com/tmux/tmux",
      publisher: "Jason Long",
      licenseText:
        "Copyright (c) 2015, Jason Long <jason@jasonlong.me>\n\n" +
        "Permission to use, copy, modify, and/or distribute this software for any " +
        "purpose with or without fee is hereby granted, provided that the above " +
        "copyright notice and this permission notice appear in all copies.\n\n" +
        'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES ' +
        "WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF " +
        "MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR " +
        "ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES " +
        "WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN " +
        "ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF " +
        "OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
    },
  ]),
];

function isMissingLicense(entry: LicenseEntry): boolean {
  return (
    !entry.licenses ||
    /\bunknown\b/i.test(String(entry.licenses)) ||
    /\bunlicensed\b/i.test(String(entry.licenses))
  );
}

function renderText(entries: LicenseEntry[]): string {
  const header = [
    "Third-Party Licenses",
    "====================",
    "",
    "This file is generated from production npm dependencies as pnpm resolves",
    "them (the app's and the bundled sm's), the Go modules linked into the bundled",
    "file-sync engine and darwin helper, and the other binaries the packaged app",
    "bundles.",
    `Packages: ${entries.length}`,
    "",
  ];

  const body = entries.flatMap((entry) => {
    const lines = [
      "--------------------------------------------------------------------------------",
      `${entry.name}@${entry.version}`,
      `License: ${entry.licenses}`,
    ];

    if (entry.repository) lines.push(`Repository: ${entry.repository}`);
    if (entry.url) lines.push(`URL: ${entry.url}`);
    if (entry.publisher) lines.push(`Publisher: ${entry.publisher}`);
    if (entry.licenseFile) lines.push(`License file: ${entry.licenseFile}`);
    if (entry.copyright) lines.push(`Copyright: ${entry.copyright}`);

    lines.push("");
    lines.push(entry.licenseText || "No license text found.");
    lines.push("");

    return lines;
  });

  return [...header, ...body].join("\n");
}

async function main() {
  const npmEntries = await npmPackageEntries();

  const goEntries = (
    await Promise.all(GO_MODULES.map((dir) => goModuleEntries(dir)))
  ).flat();
  // One entry per module version: the CLI and the engine share several
  // dependencies.
  const goByKey = new Map(
    goEntries.map((entry) => [`${entry.name}@${entry.version}`, entry]),
  );
  const entries = [
    ...npmEntries,
    ...BUNDLED_BINARIES,
    ...BUNDLED_DATA,
    ...goByKey.values(),
  ].toSorted((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );

  const missingLicenses = entries.filter(isMissingLicense);
  if (missingLicenses.length > 0) {
    console.error(
      "[licenses] missing or unknown license metadata:\n" +
        missingLicenses
          .map(
            (entry) => `  - ${entry.name}@${entry.version}: ${entry.licenses}`,
          )
          .join("\n"),
    );
    process.exitCode = 1;
    if (CHECK) return;
  }

  const outputs: [string, string][] = [
    [JSON_OUT, JSON.stringify(entries, null, 2) + "\n"],
    [TEXT_OUT, renderText(entries)],
  ];

  // Check compares instead of writing: the packaging hook regenerates
  // these, so a stale committed copy would ship as a "-dirty" build.
  if (CHECK) {
    const stale = (
      await Promise.all(
        outputs.map(async ([file, content]) =>
          (await readFile(file, "utf8").catch(() => null)) === content
            ? null
            : relative(appRoot, file),
        ),
      )
    ).filter((file) => file !== null);
    if (stale.length > 0) {
      console.error(
        `[licenses] out of date: ${stale.join(", ")}. ` +
          "Run `pnpm run licenses` and commit the result.",
      );
      process.exitCode = 1;
    } else {
      console.log(`[licenses] ${entries.length} notices are up to date`);
    }
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all(outputs.map(([file, content]) => writeFile(file, content)));

  console.log(
    `[licenses] wrote ${entries.length} production dependency notices to ` +
      "resources/licenses/",
  );
}

main().catch((err) => {
  console.error("[licenses] failed to generate third-party notices:", err);
  process.exit(1);
});
