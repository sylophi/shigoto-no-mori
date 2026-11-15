#!/usr/bin/env node
// electron-winstaller's install script, which this repo disables
// (pnpm-workspace.yaml: allowBuilds), as a postinstall step instead:
// Squirrel packs the Windows installer with the vendored 7-Zip for this
// machine's architecture, which it expects as 7z.exe and 7z.dll.

import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const vendor = resolve(
  import.meta.dirname,
  "../node_modules/electron-winstaller/vendor",
);
for (const ext of ["exe", "dll"]) {
  copyFileSync(
    join(vendor, `7z-${process.arch}.${ext}`),
    join(vendor, `7z.${ext}`),
  );
}
