// Enforces the host/client split at the source level, so the split
// can't erode one convenient import at a time. host/ is the code that
// will one day serve a remote client, shared/ is the contract layer
// both sides compile, and neither may know Electron exists. Remoteness
// itself lives in the transport a connection is built on -- feature
// modules never branch on where they run.
//
// One pass reads each source file once, strips comments (prose may
// mention anything), collects its import specifiers, and applies the
// rules for its directory:
//   1. No electron import (value, type, require, dynamic, bare side
//      effect, export-from, and subpaths like "electron/main" or
//      cousins like "electron-updater") anywhere under host/ or
//      shared/.
//   2. No import from main/ anywhere under host/ or shared/. main/ is
//      the Electron binding layer, so depending on it drags Electron in
//      transitively.
//   3. Every file under shared/ipc/modules that exports a contract
//      declares its side through defineContract with a literal "host"
//      or "client" scope. Schema-only helpers pass free. Zero
//      contract-exporting files found means the predicate rotted, and
//      that fails too.
//   4. Canary: the `isRemote` identifier must not appear under host/,
//      shared/, or renderer/.
//   5. ipcRenderer appears only in main/preloadTransport.ts, the one
//      sanctioned ClientTransport binding.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { repoRoot, report, stripComments, walk } from "./lib/checkKit.mjs";

const failures = [];

const SOURCE_EXTENSIONS = /\.(mts|cts|ts|tsx|js|jsx|mjs|cjs)$/;
// One specifier scan feeds every import rule. Catches `from "x"` (both
// import and export forms), require, dynamic import, and bare side
// effect imports like `import "x"`.
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const CONTRACT_EXPORT = /export const \w+Contract/;
const DEFINE_CONTRACT_SCOPE = /defineContract\(\s*["'](host|client)["']/;
const IS_REMOTE = /\bisRemote\b/;
const IPC_RENDERER = /\bipcRenderer\b/;

const mainDir = join(repoRoot, "main");
const modulesDir = join(repoRoot, "shared", "ipc", "modules");
const IPC_RENDERER_ALLOWLIST = new Set(["main/preloadTransport.ts"]);

const isElectronSpecifier = (spec) =>
  spec === "electron" ||
  spec.startsWith("electron/") ||
  spec.startsWith("electron-") ||
  spec.startsWith("@electron/");

const isMainSpecifier = (spec, fileDir) => {
  if (spec === "main" || spec.startsWith("main/")) return true;
  if (!spec.startsWith(".")) return false;
  const target = resolve(fileDir, spec);
  return target === mainDir || target.startsWith(mainDir + sep);
};

const visitedAllowlisted = new Set();
let contractModuleCount = 0;

for (const dir of ["host", "main", "renderer", "shared", "web"]) {
  for (const file of walk(join(repoRoot, dir), SOURCE_EXTENSIONS)) {
    const rel = relative(repoRoot, file);
    const src = stripComments(readFileSync(file, "utf8"));
    const fileDir = dirname(file);
    // web/ is the browser client platform: like host/ and shared/ it must
    // stay Electron free and must not reach into the main/ binding layer.
    const contractLayer = dir === "host" || dir === "shared" || dir === "web";
    if (IPC_RENDERER_ALLOWLIST.has(rel)) visitedAllowlisted.add(rel);

    const specifiers = [...src.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]);

    // 1 + 2. Electron must be unreachable from host/ and shared/,
    //        directly and through the binding layer in main/.
    if (contractLayer && specifiers.some(isElectronSpecifier)) {
      failures.push(
        `${rel} imports electron -- ${dir}/ must stay Electron free`,
      );
    }
    if (
      contractLayer &&
      specifiers.some((spec) => isMainSpecifier(spec, fileDir))
    ) {
      failures.push(
        `${rel} imports from main/ -- ${dir}/ must not depend on the Electron binding layer`,
      );
    }

    // 3. A scope-less contract module would silently default to
    //    nothing: later layers route calls by scope, so every module
    //    must pick a side with a literal.
    if (file.startsWith(modulesDir + sep) && CONTRACT_EXPORT.test(src)) {
      contractModuleCount += 1;
      if (!DEFINE_CONTRACT_SCOPE.test(src)) {
        failures.push(
          `${rel} does not declare a scope via defineContract("host" | "client", ...)`,
        );
      }
    }

    // 4. Device-conditional canary.
    if (dir !== "main" && IS_REMOTE.test(src)) {
      failures.push(
        `${rel} references isRemote -- remoteness lives at the connection layer, not in feature modules. A sanctioned connection-layer use gets an allowlist added to this check.`,
      );
    }

    // 5. Everything above the preload transport speaks ClientTransport.
    if (!IPC_RENDERER_ALLOWLIST.has(rel) && IPC_RENDERER.test(src)) {
      failures.push(
        `${rel} references ipcRenderer -- the one sanctioned consumer is main/preloadTransport.ts`,
      );
    }
  }
}

// Sanity floor for rule 3. If no file matched the contract-export
// predicate, the naming convention moved and the scope rule is checking
// nothing.
if (contractModuleCount === 0) {
  failures.push(
    `no contract-exporting files (matching ${CONTRACT_EXPORT}) found under shared/ipc/modules -- the scope rule's predicate no longer matches anything`,
  );
}

// A stale allowlist entry means the sanctioned file moved and rule 5 is
// silently exempting a path that no longer exists.
for (const entry of IPC_RENDERER_ALLOWLIST) {
  if (!visitedAllowlisted.has(entry)) {
    failures.push(
      `allowlisted file ${entry} was never visited -- it moved or was deleted, update IPC_RENDERER_ALLOWLIST`,
    );
  }
}

report({
  name: "host boundary",
  failures,
  hint: "Move the Electron dependency into main/, or route the capability through the contract's transport layer (see shared/ipc/transport.ts and shared/ipc/registerContract.ts).",
});
