#!/usr/bin/env node
// Enforces the three-layer architecture of `main/`:
//   - main/lib/**       pure backend; no electron, schemas, ipc, or electron-layer imports
//   - main/ipc/**       IPC adapters; may not import main/electron/**
//   - main/electron/**  wiring; may not import ipcMain/ipcRenderer, may not send webContents.send
//   - main/preload/**   preload context; may not import main/lib/** or main/electron/**
//
// Uses the TypeScript compiler API so re-exports, dynamic imports, and
// `import type` are caught alongside regular imports. Relative specifiers
// resolve to repo-relative paths before the rules run; path aliases
// declared under `tsconfig.json` `compilerOptions.paths` are loaded at
// startup.
//
// Allowlist entries below mark pre-existing violations that Phase 3+
// migrations will remove. Run with `--strict` to fail on every allowlisted
// violation (audit mode).
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { glob } from "tinyglobby";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = "scripts/check-layering.fixtures";

const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const FIXTURES = args.has("--fixtures");

// Pre-existing violations that Phase 3+ migrations will sweep away.
// Each comment explains the migration that removes the entry. After the
// scan, any entry that didn't fire is reported as stale so a Phase 3 PR
// can't silently weaken a rule by removing the violation but leaving the
// allowlist line behind.
const allowlist = {
  // main/lib/** files that still import Zod schemas at runtime.
  schemaRuntimeImports: new Set([
    "main/lib/git/branches.ts", // Phase 3 (git): isRealBranch
    "main/lib/git/worktrees.ts", // Phase 3 (git): UNKNOWN_BRANCH
    "main/lib/config/global.ts", // Phase 3 (config): GlobalConfigSchema, ThemeSchema
    "main/lib/config/project.ts", // Phase 3 (config): ShigomoriConfigSchema, ShigomoriWorktreeDataSchema
    "main/lib/githubCli/pullRequests.ts", // Phase 3 (githubCli): schemas + pullRequestsEqual
  ]),
  // main/lib/** files that still import from "electron" at runtime
  // (type-only imports are not flagged in the first place).
  electronRuntimeImports: new Set(),
  // main/lib/** files that import the WebContents type from electron.
  // Pure types are normally allowed, but the layering rule is "no
  // electron coupling in lib"; once the broadcast helper owns sends,
  // these imports go away with their callers.
  electronTypeImports: new Set([
    "main/lib/worktrees/lifecycle.ts", // Phase 3 (worktrees broadcasts): WebContents for `send`
    "main/lib/scripts/index.ts", // Phase 3 (scripts broadcasts): WebContents for `send`
  ]),
  // Files that still call `webContents.send` directly. The contract's
  // broadcast helper is the only sanctioned source post-migration.
  webContentsSend: new Set([
    "main/lib/worktrees/lifecycle.ts", // Phase 3 (worktrees broadcasts)
    "main/lib/scripts/index.ts", // Phase 3 (scripts broadcasts)
    "main/electron/updater.ts", // Phase 3 (updater broadcasts)
    "main/electron/menu.ts", // Phase 3 (palette / nav / menu broadcasts)
    "main/electron/fetch.ts", // Phase 3 (git fetch broadcasts; may earn its own feature surface)
    "main/index.ts", // Phase 3 (window focus / blur broadcasts)
  ]),
  // main/ipc/** files that still import from main/electron/**. Phase 3
  // moves each feature's wiring into its own module so the menu/updater
  // adapters compose lib functions directly.
  ipcImportingElectron: new Set([
    "main/ipc/menu.ts", // Phase 3 (menu migration)
    "main/ipc/updater.ts", // Phase 3 (updater migration)
    "main/ipc/runtime.ts", // Phase 3 (runtime migration): nukeEverything currently composes window-aware logic
  ]),
};

// Tracks which allowlist entries actually fired during this scan. Any
// entry left untouched is reported as stale at the end.
const allowlistUses = new Map(
  Object.keys(allowlist).map((rule) => [rule, new Set()]),
);

function checkAllowed(rule, listName, repoPath, line, message) {
  if (allowlist[listName].has(repoPath)) {
    allowlistUses.get(listName).add(repoPath);
    if (STRICT) {
      report(`${rule} (allowlisted)`, repoPath, line, `allowlisted ${message}`);
    }
    return;
  }
  report(rule, repoPath, line, message);
}

const tsconfig = JSON.parse(
  readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8"),
);
const pathAliases = compileAliases(tsconfig.compilerOptions?.paths ?? {});

function compileAliases(raw) {
  const entries = [];
  for (const [pattern, targets] of Object.entries(raw)) {
    const prefix = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
    const target = (targets[0] ?? "").replace(/\/\*$/, "").replace(/^\.\//, "");
    entries.push({ prefix, target });
  }
  return entries.toSorted((a, b) => b.prefix.length - a.prefix.length);
}

function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith(".")) {
    const absolute = resolve(dirname(fromFile), specifier);
    return relative(REPO_ROOT, absolute);
  }
  for (const { prefix, target } of pathAliases) {
    if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
      const rest = specifier.slice(prefix.length).replace(/^\//, "");
      return target + (rest ? `/${rest}` : "");
    }
  }
  return null;
}

function repoRelative(file) {
  return relative(REPO_ROOT, file);
}

function layerOf(repoPath) {
  if (repoPath === "main/preload.ts" || repoPath.startsWith("main/preload/"))
    return "preload";
  if (repoPath.startsWith("main/lib/")) return "lib";
  if (repoPath.startsWith("main/ipc/")) return "ipc";
  if (repoPath.startsWith("main/electron/")) return "electron";
  if (repoPath === "main/index.ts") return "entry";
  return null;
}

function specifierIsSchemaModule(spec) {
  return spec === "@shared/schemas" || spec.startsWith("@shared/schemas/");
}

function collectImports(source) {
  const out = [];
  source.forEachChild(function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        const clause = node.importClause;
        const typeOnly = clause?.isTypeOnly ?? false;
        const named = [];
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            named.push({
              name: el.name.text,
              typeOnly: typeOnly || el.isTypeOnly,
            });
          }
        }
        const everyNameIsType =
          named.length > 0 && named.every((n) => n.typeOnly);
        const hasValueDefault = !!clause?.name && !typeOnly;
        const hasNamespace =
          clause?.namedBindings &&
          ts.isNamespaceImport(clause.namedBindings) &&
          !typeOnly;
        const sideEffect = !clause;
        // A bare side-effect import like `import "foo"` is runtime by
        // definition; `import type` is fully type-only; an import with
        // some named-only-type elements is runtime only if it also
        // brings in any value (default, namespace, or non-type named).
        const isRuntime =
          sideEffect ||
          hasValueDefault ||
          hasNamespace ||
          (!typeOnly && named.length > 0 && !everyNameIsType);
        out.push({
          kind: "import",
          specifier: spec.text,
          isRuntime,
          named,
          node: spec,
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push({
        kind: "export",
        specifier: node.moduleSpecifier.text,
        isRuntime: !node.isTypeOnly,
        named: [],
        node: node.moduleSpecifier,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push({
        kind: "dynamic",
        specifier: node.arguments[0].text,
        isRuntime: true,
        named: [],
        node: node.arguments[0],
      });
    }
    ts.forEachChild(node, visit);
  });
  return out;
}

// Detects `webContents.send(...)` (or `xxx.webContents.send(...)`)
// without per-symbol type info. The receiver can be any identifier or
// property-access chain that ends in the property name `webContents`.
function findWebContentsSendCalls(source) {
  const results = [];
  source.forEachChild(function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "send"
    ) {
      const receiver = node.expression.expression;
      const text = receiver.getText(source);
      if (
        text === "webContents" ||
        text.endsWith(".webContents") ||
        text.endsWith("?.webContents")
      ) {
        results.push(node.expression.name);
      }
    }
    ts.forEachChild(node, visit);
  });
  return results;
}

const violations = [];
function report(rule, file, line, message) {
  violations.push({ rule, file, line, message });
}

function lineOf(source, pos) {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

const filePatterns = FIXTURES
  ? [`${FIXTURES_DIR}/**/*.ts`]
  : ["main/**/*.ts", "main/**/*.tsx"];
const files = await glob(filePatterns, { cwd: REPO_ROOT, absolute: true });

for (const absPath of files) {
  const repoPath = repoRelative(absPath);
  if (repoPath.startsWith("scripts/") && !FIXTURES) continue;
  const layer = FIXTURES ? "lib" : layerOf(repoPath);
  if (!layer) continue;

  const content = readFileSync(absPath, "utf8");
  const source = ts.createSourceFile(
    absPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = collectImports(source);

  for (const imp of imports) {
    const resolved = resolveSpecifier(imp.specifier, absPath);

    const line = lineOf(source, imp.node.pos);

    if (layer === "lib") {
      if (imp.specifier === "electron" && imp.isRuntime) {
        checkAllowed(
          "lib-electron-runtime",
          "electronRuntimeImports",
          repoPath,
          line,
          `runtime import of "electron" not allowed in main/lib`,
        );
      }
      if (imp.specifier === "electron" && !imp.isRuntime) {
        checkAllowed(
          "lib-electron-type",
          "electronTypeImports",
          repoPath,
          line,
          `type import of "electron" not allowed in main/lib`,
        );
      }
      if (specifierIsSchemaModule(imp.specifier) && imp.isRuntime) {
        checkAllowed(
          "lib-schema-runtime",
          "schemaRuntimeImports",
          repoPath,
          line,
          `runtime import of "${imp.specifier}" not allowed in main/lib (type-only is fine)`,
        );
      }
      if (
        resolved &&
        (resolved.startsWith("main/ipc/") ||
          resolved.startsWith("main/electron/"))
      ) {
        report(
          "lib-upward-import",
          repoPath,
          line,
          `main/lib cannot import "${imp.specifier}" (resolves to ${resolved})`,
        );
      }
    } else if (layer === "ipc") {
      if (resolved && resolved.startsWith("main/electron/")) {
        checkAllowed(
          "ipc-electron-import",
          "ipcImportingElectron",
          repoPath,
          line,
          `main/ipc cannot import "${imp.specifier}" (resolves to ${resolved})`,
        );
      }
    } else if (layer === "electron" || layer === "entry") {
      if (imp.specifier === "electron" && imp.isRuntime) {
        for (const n of imp.named) {
          if (
            !n.typeOnly &&
            (n.name === "ipcMain" || n.name === "ipcRenderer")
          ) {
            report(
              "electron-ipc-import",
              repoPath,
              lineOf(source, imp.node.pos),
              `${layer === "entry" ? "main/index.ts" : "main/electron"} cannot import "${n.name}" from electron`,
            );
          }
        }
      }
    } else if (layer === "preload") {
      if (
        resolved &&
        (resolved.startsWith("main/lib/") ||
          resolved.startsWith("main/electron/"))
      ) {
        report(
          "preload-import",
          repoPath,
          lineOf(source, imp.node.pos),
          `main/preload cannot import "${imp.specifier}" (resolves to ${resolved})`,
        );
      }
    }
  }

  // The broadcast helper in main/ipc/register.ts is the only sanctioned
  // home for `webContents.send`. Every other layer is checked.
  if (repoPath !== "main/ipc/register.ts") {
    for (const ident of findWebContentsSendCalls(source)) {
      const line = lineOf(source, ident.pos);
      const msg = `webContents.send outside main/ipc/register.ts`;
      if (layer === "ipc") {
        report("webcontents-send", repoPath, line, msg);
      } else {
        checkAllowed(
          "webcontents-send",
          "webContentsSend",
          repoPath,
          line,
          msg,
        );
      }
    }
  }
}

// Skip the stale-entry sweep when scanning fixtures: the fixtures path
// doesn't exercise any real allowlist entry, so every entry would appear
// stale.
if (!FIXTURES) {
  for (const [listName, list] of Object.entries(allowlist)) {
    const used = allowlistUses.get(listName);
    for (const entry of list) {
      if (!used.has(entry)) {
        report(
          "stale-allowlist",
          entry,
          0,
          `allowlist entry under "${listName}" no longer fires; remove it`,
        );
      }
    }
  }
}

if (violations.length === 0) {
  if (FIXTURES) {
    console.error(
      "scripts/check-layering.fixtures/ produced no violations (expected at least one)",
    );
    process.exit(1);
  }
  process.exit(0);
}

const grouped = new Map();
for (const v of violations) {
  if (!grouped.has(v.rule)) grouped.set(v.rule, []);
  grouped.get(v.rule).push(v);
}

for (const [rule, items] of grouped) {
  console.error(`# ${rule}`);
  for (const v of items) {
    console.error(`  ${v.file}:${v.line}  ${v.message}`);
  }
}
console.error(
  `\n${violations.length} violation(s)${STRICT ? " (strict mode)" : ""}`,
);
process.exit(1);
