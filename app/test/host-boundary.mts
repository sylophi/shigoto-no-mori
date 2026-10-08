// Enforces the host/client split at the source level, so the split
// can't erode one convenient import at a time. host/ is the code that
// will one day serve a remote client, shared/ and the contracts
// package are what both sides compile, and none may know Electron
// exists. Remoteness
// itself lives in the transport a connection is built on -- feature
// modules never branch on where they run.
//
// One pass reads each source file once, strips comments (prose may
// mention anything), collects its import specifiers, and applies the
// rules for its directory:
//   1. No electron import (value, type, require, dynamic, bare side
//      effect, export-from, and subpaths like "electron/main" or
//      cousins like "electron-updater") anywhere under host/, shared/
//      or the contracts package.
//   2. No import from main/ anywhere under host/, shared/ or the
//      contracts package. main/ is
//      the Electron binding layer, so depending on it drags Electron in
//      transitively.
//   3. Every file under the contracts package's modules/ that exports a contract
//      declares its side through defineContract with a literal "host"
//      or "client" scope. Schema-only helpers pass free. Zero
//      contract-exporting files found means the predicate rotted, and
//      that fails too.
//   4. Canary: the `isRemote` identifier must not appear under host/,
//      shared/, renderer/ or the contracts package.
//   5. ipcRenderer appears only in main/preloadTransport.ts, the one
//      sanctioned ClientTransport binding.
//   6. main/core is the Electron-free half of the desktop binding: the
//      pure cores (stores, engines, rate limiters) the node proofs in
//      test/ drive directly. No electron import there, and no import
//      from the rest of main/, which would drag Electron in.
//   7. The contracts package imports nothing from the app: no app
//      alias, no relative path out of the package. Every side compiles
//      it, the hub included, which has no app to reach.
//
// covers: app/host/** app/main/** app/renderer/** app/shared/** app/web/** packages/contracts/src/**
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { it } from "vitest";
import { appRoot, repoRoot, stripComments, walk } from "./lib/checkKit.mts";

const failures: string[] = [];

const SOURCE_EXTENSIONS = /\.(mts|cts|ts|tsx|js|jsx|mjs|cjs)$/;
// One specifier scan feeds every import rule. Catches `from "x"` (both
// import and export forms), require, dynamic import, and bare side
// effect imports like `import "x"`.
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const CONTRACT_EXPORT = /export const \w+Contract/;
const DEFINE_CONTRACT_SCOPE =
  /defineContract\(\s*["']\w+["'],\s*["'](host|client)["']/;
const IS_REMOTE = /\bisRemote\b/;
const IPC_RENDERER = /\bipcRenderer\b/;

const mainDir = join(appRoot, "main");
const mainCoreDir = join(mainDir, "core");
const contractsDir = join(repoRoot, "packages", "contracts", "src");
const modulesDir = join(contractsDir, "modules");
const IPC_RENDERER_ALLOWLIST = new Set(["main/preloadTransport.ts"]);

const isElectronSpecifier = (spec: string) =>
  spec === "electron" ||
  spec.startsWith("electron/") ||
  spec.startsWith("electron-") ||
  spec.startsWith("@electron/");

// Whether a specifier lands in `dir` (one of main/'s folders), written
// either relative to the importing file or bare from the app root.
const pointsInto = (dir: string, spec: string, fileDir: string) => {
  const bare = spec === "main" || spec.startsWith("main/");
  if (!bare && !spec.startsWith(".")) return false;
  const target = resolve(bare ? appRoot : fileDir, spec);
  return target === dir || target.startsWith(dir + sep);
};

const isMainSpecifier = (spec: string, fileDir: string) =>
  pointsInto(mainDir, spec, fileDir);

const visitedAllowlisted = new Set<string>();
let contractModuleCount = 0;

// The folders walked, and whether each must stay Electron free and off
// the main/ binding layer. web/ is the browser client platform, so it
// is held to that like host/, shared/ and the contracts.
const LAYERS = [
  { dir: "host", root: join(appRoot, "host"), contractLayer: true },
  { dir: "main", root: mainDir, contractLayer: false },
  { dir: "renderer", root: join(appRoot, "renderer"), contractLayer: false },
  { dir: "shared", root: join(appRoot, "shared"), contractLayer: true },
  { dir: "web", root: join(appRoot, "web"), contractLayer: true },
  { dir: "packages/contracts/src", root: contractsDir, contractLayer: true },
];

for (const { dir, root, contractLayer } of LAYERS) {
  for (const file of walk(root, SOURCE_EXTENSIONS)) {
    const rel = relative(appRoot, file);
    const src = stripComments(readFileSync(file, "utf8"));
    const fileDir = dirname(file);
    if (IPC_RENDERER_ALLOWLIST.has(rel)) visitedAllowlisted.add(rel);

    const specifiers = [...src.matchAll(IMPORT_SPECIFIER)].flatMap(
      (m) => m[1] ?? [],
    );

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

    // 7. The contracts stand alone.
    if (root === contractsDir) {
      const leaves = specifiers.some(
        (spec) =>
          /^@(shared|host)?\//.test(spec) ||
          (spec.startsWith(".") &&
            !resolve(fileDir, spec).startsWith(contractsDir + sep)),
      );
      if (leaves) {
        failures.push(
          `${rel} imports from outside packages/contracts -- the contracts must not depend on the app`,
        );
      }
    }

    // 6. main/core stays drivable by plain node.
    if (file.startsWith(mainCoreDir + sep)) {
      if (specifiers.some(isElectronSpecifier)) {
        failures.push(
          `${rel} imports electron -- main/core/ must stay Electron free, the Electron half lives in main/electron/`,
        );
      }
      const leaves = specifiers.some(
        (spec) =>
          isMainSpecifier(spec, fileDir) &&
          !pointsInto(mainCoreDir, spec, fileDir),
      );
      if (leaves) {
        failures.push(
          `${rel} imports from main/ outside main/core/ -- that pulls Electron in transitively`,
        );
      }
    }

    // 3. A scope-less contract module would silently default to
    //    nothing: later layers route calls by scope, so every module
    //    must pick a side with a literal.
    if (file.startsWith(modulesDir + sep) && CONTRACT_EXPORT.test(src)) {
      contractModuleCount += 1;
      if (!DEFINE_CONTRACT_SCOPE.test(src)) {
        failures.push(
          `${rel} does not declare a scope via defineContract(name, "host" | "client", ...)`,
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
    `no contract-exporting files (matching ${CONTRACT_EXPORT}) found under packages/contracts/src/modules -- the scope rule's predicate no longer matches anything`,
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

// When one fails: move the Electron dependency into main/, or route the capability
// through the contract's transport layer (see shared/ipc/transport.ts
// and shared/ipc/registerContract.ts).
it("host boundary", () => {
  assert.deepEqual(failures, []);
});
