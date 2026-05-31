#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const licenseChecker = require("license-checker");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "licenses");
const JSON_OUT = join(OUT_DIR, "third-party-licenses.json");
const TEXT_OUT = join(OUT_DIR, "THIRD-PARTY-LICENSES.txt");
const CHECK = process.argv.includes("--check");

const initLicenseChecker = promisify(licenseChecker.init);

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
    "This file is generated from production npm dependencies with license-checker.",
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

  const entries = Object.entries(packages)
    .map(normalizeEntry)
    .toSorted((a, b) =>
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
