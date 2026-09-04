#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CLOUDFLARED_LICENSE,
  CLOUDFLARED_REPOSITORY,
  CLOUDFLARED_VERSION,
} from "../shared/cloudflaredDist.mts";

const require = createRequire(import.meta.url);
const licenseChecker = require("license-checker");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "licenses");
const JSON_OUT = join(OUT_DIR, "third-party-licenses.json");
const TEXT_OUT = join(OUT_DIR, "THIRD-PARTY-LICENSES.txt");
const CHECK = process.argv.includes("--check");

const initLicenseChecker = promisify(licenseChecker.init);
const execFileP = promisify(execFile);

// The Go modules whose binaries ship inside the app (the CLI and the
// file-sync engine), each walked for the modules ACTUALLY LINKED into
// its default build: `go list -deps` over the main package, with the
// default build tags, so a dependency reachable only through a build
// tag this project never sets (Mutagen's source-available parts behind
// `mutagensspl`) is neither compiled in nor listed.
const GO_MODULES = ["cli", "file-sync"];

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
// metadata, only the text, so the id is recognized from it; an
// unrecognized text is reported as missing so a new dependency with an
// unexpected license gets looked at rather than shipped unlabeled.
function identifyLicense(text) {
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

async function findLicenseFile(dir) {
  let names;
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

function repositoryOf(modulePath) {
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
  if (modulePath.startsWith("gopkg.in/")) return `https://${modulePath}`;
  return `https://${modulePath}`;
}

// Notes that belong beside a module's license text.
const GO_MODULE_NOTES = {
  "github.com/mutagen-io/mutagen":
    "MIT except for parts of the repository under the Server Side Public " +
    "License, which are gated behind the `mutagensspl` build tag. This " +
    "project never sets that tag, so none of that code is compiled into " +
    "the file-sync engine.",
};

async function goModuleEntries(moduleDir) {
  const { stdout } = await execFileP(
    "go",
    [
      "list",
      "-deps",
      "-f",
      "{{if and (not .Standard) .Module (not .Module.Main)}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}",
      ".",
    ],
    { cwd: join(ROOT, moduleDir), maxBuffer: 16 * 1024 * 1024 },
  );
  const modules = new Map();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [path, version, dir] = line.split("\t");
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
          // Relative to the module cache root, like license-checker's
          // relative paths for npm packages, never a machine path.
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

function splitPackageKey(key) {
  const versionSeparator = key.lastIndexOf("@");
  if (versionSeparator <= 0) {
    return { name: key, version: "" };
  }

  return {
    name: key.slice(0, versionSeparator),
    version: key.slice(versionSeparator + 1),
  };
}

function normalizeEntry([key, value]) {
  const fromKey = splitPackageKey(key);
  return {
    name: value.name || fromKey.name,
    version: value.version || fromKey.version,
    licenses: value.licenses || "UNKNOWN",
    repository: value.repository || "",
    publisher: value.publisher || "",
    url: value.url || "",
    licenseFile: value.licenseFile || "",
    licenseText: (value.licenseText || "").trim(),
    copyright: value.copyright || "",
  };
}

// Binaries the packaged app ships beside its npm dependencies. Not npm
// packages, so license-checker cannot see them. Listed by hand from
// the same pinned metadata the fetch script reads, through the same
// normalizer as every npm entry so the record shape has one owner.
const BUNDLED_BINARIES = [
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

function isMissingLicense(entry) {
  return (
    !entry.licenses ||
    /\bunknown\b/i.test(entry.licenses) ||
    /\bunlicensed\b/i.test(entry.licenses)
  );
}

function renderText(entries) {
  const header = [
    "Third-Party Licenses",
    "====================",
    "",
    "This file is generated from production npm dependencies with license-checker,",
    "the Go modules linked into the bundled sm CLI and file-sync engine, and the",
    "other binaries the packaged app bundles.",
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
  const packages = await initLicenseChecker({
    start: ROOT,
    production: true,
    excludePrivatePackages: true,
    relativeLicensePath: true,
    customFormat: {
      name: "",
      version: "",
      licenses: "",
      repository: "",
      publisher: "",
      url: "",
      licenseFile: "",
      licenseText: "",
      copyright: "",
    },
  });

  const goEntries = (
    await Promise.all(GO_MODULES.map((dir) => goModuleEntries(dir)))
  ).flat();
  // One entry per module version: the CLI and the engine share several
  // dependencies.
  const goByKey = new Map(
    goEntries.map((entry) => [`${entry.name}@${entry.version}`, entry]),
  );
  const entries = [
    ...Object.entries(packages).map(normalizeEntry),
    ...BUNDLED_BINARIES,
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

  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(JSON_OUT, JSON.stringify(entries, null, 2) + "\n"),
    writeFile(TEXT_OUT, renderText(entries)),
  ]);

  console.log(
    `[licenses] wrote ${entries.length} production dependency notices to ` +
      "resources/licenses/",
  );
}

main().catch((err) => {
  console.error("[licenses] failed to generate third-party notices:", err);
  process.exit(1);
});
