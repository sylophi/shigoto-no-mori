// The task runners `sm run` offers next to package.json: a justfile's
// recipes and a Makefile's targets. Both are read as text, not through
// `just --dump` or `make -p`, so listing spawns nothing and works with
// neither tool installed. A recipe or target is listed as "just build"
// or "make test", which keeps it apart from a package.json script of
// the same name everywhere a script is known by its name (the use log,
// the manual order, the launch row).

export type Runner = "just" | "make";

// A recipe or target: `name` is the one it is listed and run by,
// `label` the one it goes by in its file.
type RunnerScript = {
  readonly name: string;
  readonly command: string;
  readonly label: string;
  readonly runner: Runner;
};

// The file each runner reads among a directory's files, by its own
// lookup rules: just matches "justfile" and ".justfile" in any case,
// make tries GNUmakefile, makefile, then Makefile. Undefined when there
// is none. Matched against the listing rather than stat'ed, which on a
// case-insensitive disk would answer for the wrong spelling.
export const findJustfile = (files: ReadonlyArray<string>) =>
  files.find((name) => {
    const lower = name.toLowerCase();
    return lower === "justfile" || lower === ".justfile";
  });

export const findMakefile = (files: ReadonlyArray<string>) =>
  ["GNUmakefile", "makefile", "Makefile"].find((name) => files.includes(name));

export const findPackageJson = (files: ReadonlyArray<string>) =>
  files.includes("package.json") ? "package.json" : undefined;

const JUST_RECIPE_HEADER = /^@?([A-Za-z_][A-Za-z0-9_-]*)/;

// Whether a line starts with a space or a tab: a recipe's body.
const indented = (line: string) =>
  line.startsWith(" ") || line.startsWith("\t");

const lines = (raw: string) =>
  raw.split("\n").map((line) => line.replace(/\r+$/, ""));

// A justfile's public recipes in file order. A recipe header starts at
// column 0 with its name and has a ':' that isn't the start of ':='
// (an assignment, alias or setting). Recipes named with a leading '_'
// or marked [private] are left out, as `just --list` leaves them out.
// The command shown is the body, or the dependencies when it has none.
export function parseJustfile(raw: string): ReadonlyArray<RunnerScript> {
  const scripts: RunnerScript[] = [];
  const seen = new Set<string>();
  let isPrivate = false;
  const all = lines(raw);
  for (let i = 0; i < all.length; i++) {
    const line = all[i] as string;
    if (line.startsWith("[")) {
      isPrivate ||= hasPrivateAttribute(line);
      continue;
    }
    const match = JUST_RECIPE_HEADER.exec(line);
    const colon = unquotedColon(line);
    if (match === null || colon < 0 || line.startsWith(":=", colon)) {
      if (line.trim() !== "" && !line.startsWith("#")) isPrivate = false;
      continue;
    }
    const name = match[1] as string;
    const hidden = isPrivate || name.startsWith("_");
    isPrivate = false;

    const body: string[] = [];
    while (i + 1 < all.length) {
      const next = all[i + 1] as string;
      if (next !== "" && !indented(next)) break;
      i++;
      const step = next.trim().replace(/^[@-]+/, "");
      if (step !== "") body.push(step);
    }
    if (hidden || seen.has(name)) continue;
    seen.add(name);
    scripts.push({
      name: `just ${name}`,
      command: stepsOr(body, line.slice(colon + 1)),
      label: name,
      runner: "just",
    });
  }
  return scripts;
}

// Whether an attribute line ("[private]", "[no-cd, private]") holds the
// private attribute.
const hasPrivateAttribute = (line: string) =>
  line
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .some((attribute) => attribute.trim() === "private");

// The first ':' outside a quoted string, so a parameter default like
// addr="localhost:8080" isn't taken for the recipe's colon. -1 when
// there is none.
function unquotedColon(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ":") {
      return i;
    }
  }
  return -1;
}

// A Makefile's named targets in file order. Pattern rules, special
// targets (.PHONY), and file targets (anything with a '.', '/' or a
// variable in it) are left out, which leaves the ones meant to be run
// by name. Variable assignments, target-specific ones included, define
// blocks, and function calls like $(error ...) aren't rules. A target
// declared more than once keeps its first place and the first recipe
// it is given.
export function parseMakefile(raw: string): ReadonlyArray<RunnerScript> {
  const scripts: RunnerScript[] = [];
  const index = new Map<string, number>();
  const hasRecipe = new Set<string>();
  const all = lines(raw);
  // Continued lines read as one.
  const joined: string[] = [];
  for (let i = 0; i < all.length; i++) {
    let line = all[i] as string;
    while (line.endsWith("\\") && i + 1 < all.length) {
      i++;
      line = `${line.slice(0, -1).replace(/[ \t]+$/, "")} ${(all[i] as string).trim()}`;
    }
    joined.push(line);
  }

  let inDefine = false;
  for (let i = 0; i < joined.length; i++) {
    const line = joined[i] as string;
    const trimmed = line.trim();
    if (inDefine) {
      inDefine = trimmed !== "endef";
      continue;
    }
    const directive = trimmed.replace(/^export /, "").replace(/^override /, "");
    if (directive.startsWith("define ") || directive === "define") {
      inDefine = true;
      continue;
    }
    if (line === "" || "\t #$".includes(line[0] as string)) continue;
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).includes("=")) continue;
    const rest = line.slice(colon + 1).replace(/^:/, "");
    if (rest.startsWith("=")) continue;
    const semicolon = rest.indexOf(";");
    const prereqs = semicolon < 0 ? rest : rest.slice(0, semicolon);
    const inline = semicolon < 0 ? "" : rest.slice(semicolon + 1);
    if (prereqs.includes("=")) continue;

    const body: string[] = [];
    const first = makeStep(inline);
    if (first !== "") body.push(first);
    while (i + 1 < joined.length) {
      const next = joined[i + 1] as string;
      if (
        next !== "" &&
        !next.startsWith("\t") &&
        !next.trim().startsWith("#")
      ) {
        break;
      }
      i++;
      if (next.startsWith("\t")) {
        const step = makeStep(next);
        if (step !== "") body.push(step);
      }
    }

    const command = stepsOr(body, prereqs);
    for (const target of line.slice(0, colon).trim().split(/\s+/)) {
      if (target === "" || /[.%/$()&]/.test(target)) continue;
      const at = index.get(target);
      if (at !== undefined) {
        if (body.length > 0 && !hasRecipe.has(target)) {
          scripts[at] = { ...(scripts[at] as RunnerScript), command };
          hasRecipe.add(target);
        }
        continue;
      }
      index.set(target, scripts.length);
      if (body.length > 0) hasRecipe.add(target);
      scripts.push({
        name: `make ${target}`,
        command,
        label: target,
        runner: "make",
      });
    }
  }
  return scripts;
}

// A recipe line as it reads to a person: the echo and error prefixes
// make strips are stripped here too, and a comment line is dropped.
function makeStep(line: string): string {
  const step = line.trim().replace(/^[@\-+ \t]+/, "");
  return step.startsWith("#") ? "" : step;
}

const stepsOr = (steps: ReadonlyArray<string>, fallback: string) =>
  steps.length > 0 ? steps.join("; ") : fallback.trim();
