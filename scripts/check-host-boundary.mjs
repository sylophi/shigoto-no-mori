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
//   6. The HostApi Pick in the renderer's HostScope file names exactly
//      the host-scoped namespaces buildApi exposes. Both sides are read
//      from source (the Pick list, and buildApi's return object joined
//      with each contract's defineContract scope), so the rule fails
//      when either side drifts.
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

// 6. HostApi drift guard. The expected set is derived, not hardcoded:
//    every top-level namespace in buildApi's return object is mapped to
//    the contract its client was built from, and a namespace is
//    host-scoped when that contract is defineContract("host", ...).
//    This covers facades too (worktreeData rides shigomoriContract).
//    The HostApi Pick must equal that set exactly, in either direction.
const HOST_SCOPE_FILE = "renderer/hooks/remote/useHostScope.tsx";

// contractName -> "host" | "client", read off the module sources.
const contractScopes = new Map();
for (const file of walk(modulesDir, SOURCE_EXTENSIONS)) {
  const src = stripComments(readFileSync(file, "utf8"));
  for (const m of src.matchAll(
    /export const (\w+Contract) = defineContract\(\s*["'](host|client)["']/g,
  )) {
    contractScopes.set(m[1], m[2]);
  }
}

// The namespaces buildApi exposes, each mapped to the contracts its
// section's clients were built from.
function buildApiHostNamespaces() {
  const src = stripComments(
    readFileSync(join(repoRoot, "shared", "ipc", "client.ts"), "utf8"),
  );
  const buildApiIndex = src.indexOf("function buildApi");
  const returnIndex = src.indexOf("return {", buildApiIndex);
  if (buildApiIndex === -1 || returnIndex === -1) {
    failures.push(
      "shared/ipc/client.ts: buildApi's return object not found -- rule 6's predicate no longer matches, update check-host-boundary",
    );
    return null;
  }
  // clientVar -> contractName, from `const fooClient = c(fooContract);`.
  const clientContracts = new Map();
  for (const m of src.matchAll(/const (\w+) = c\((\w+Contract)\);/g)) {
    clientContracts.set(m[1], m[2]);
  }
  // Slice out the return object by brace balancing, then split it into
  // top-level `name: { ... }` sections the same way.
  const openIndex = src.indexOf("{", returnIndex);
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      closeIndex = i;
      break;
    }
  }
  const body = src.slice(openIndex + 1, closeIndex);
  const hostNamespaces = new Set();
  depth = 0;
  let name = null;
  for (let i = 0, start = 0; i < body.length; i++) {
    if (body[i] === "{") {
      if (depth === 0) {
        name = /(\w+):\s*$/.exec(body.slice(0, i))?.[1] ?? null;
        start = i;
      }
      depth++;
    } else if (body[i] === "}" && --depth === 0 && name) {
      const section = body.slice(start, i + 1);
      const contracts = [...section.matchAll(/\b(\w+Client)\b/g)].map((m) =>
        clientContracts.get(m[1]),
      );
      if (contracts.length === 0 || contracts.some((c) => !c)) {
        failures.push(
          `shared/ipc/client.ts: buildApi namespace "${name}" references no known contract client -- rule 6 can't classify it, update check-host-boundary`,
        );
      } else if (contracts.some((c) => contractScopes.get(c) === "host")) {
        hostNamespaces.add(name);
      }
      name = null;
    }
  }
  if (hostNamespaces.size === 0) {
    failures.push(
      "shared/ipc/client.ts: no host-scoped buildApi namespaces found -- rule 6's predicate no longer matches anything",
    );
    return null;
  }
  return hostNamespaces;
}

function hostApiPickNames() {
  let src;
  try {
    src = stripComments(readFileSync(join(repoRoot, HOST_SCOPE_FILE), "utf8"));
  } catch {
    failures.push(
      `${HOST_SCOPE_FILE} is missing -- the HostApi Pick moved, update HOST_SCOPE_FILE in check-host-boundary`,
    );
    return null;
  }
  const pick = /type HostApi = Pick<\s*RemoteDeviceApi,([^>]*)>/.exec(src);
  if (!pick) {
    failures.push(
      `${HOST_SCOPE_FILE}: HostApi Pick<RemoteDeviceApi, ...> not found -- rule 6's predicate no longer matches, update check-host-boundary`,
    );
    return null;
  }
  return new Set([...pick[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));
}

const expectedHostNamespaces = buildApiHostNamespaces();
const pickedHostNamespaces = hostApiPickNames();
if (expectedHostNamespaces && pickedHostNamespaces) {
  for (const namespace of expectedHostNamespaces) {
    if (!pickedHostNamespaces.has(namespace)) {
      failures.push(
        `${HOST_SCOPE_FILE}: HostApi is missing "${namespace}" -- buildApi exposes it over a host-scoped contract, so host hooks must see it`,
      );
    }
  }
  for (const namespace of pickedHostNamespaces) {
    if (!expectedHostNamespaces.has(namespace)) {
      failures.push(
        `${HOST_SCOPE_FILE}: HostApi picks "${namespace}", which is not a host-scoped buildApi namespace -- it would reject at runtime on a remote device`,
      );
    }
  }
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
