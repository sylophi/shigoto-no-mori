// The gitignore rules a worktree is under, as engine patterns: every
// .gitignore in the checkout (tracked or not yet, ignored ones aside)
// and the repo's info/exclude, comments and blank lines dropped. A
// mirror that leaves gitignored files out feeds these to the engine,
// whose ignore syntax reads the common gitignore forms (a leading /
// anchors, a trailing / means a directory, ! negates, ** spans
// folders), so a file ignored AFTER the mirror opened stays out too,
// where a snapshot of ignored paths would let it cross. A nested
// file's rules are relative to its folder, so they are re-anchored:
// a rule with a slash of its own is pinned under the folder, and a
// bare name matches at any depth beneath it, as git reads them.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./core";

export const IGNORE_RULES_LIMIT = 512;

async function readRules(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// A nested .gitignore's rule as a root-relative pattern.
export function anchorRule(rule: string, folder: string): string {
  if (folder === "") return rule;
  const negated = rule.startsWith("!");
  const body = negated ? rule.slice(1) : rule;
  // A slash anywhere but the end pins the rule to its folder. A bare
  // name (or name/) matches at any depth below it.
  const pinned = body.startsWith("/") || body.slice(0, -1).includes("/");
  const anchored = pinned
    ? `/${folder}/${body.replace(/^\//, "")}`
    : `/${folder}/**/${body}`;
  return negated ? `!${anchored}` : anchored;
}

// Every .gitignore git can see: tracked ones and untracked ones it
// does not itself ignore. The pathspec's * spans folders.
async function listIgnoreFiles(worktreePath: string): Promise<string[]> {
  try {
    const out = await run(worktreePath, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".gitignore",
      "*/.gitignore",
    ]);
    return out.split("\0").filter((path) => path !== "");
  } catch {
    return [".gitignore"];
  }
}

export async function listIgnoreRules(worktreePath: string): Promise<string[]> {
  const files = await listIgnoreFiles(worktreePath);
  const rules: string[] = [];
  for (const file of files.toSorted()) {
    const folder = dirname(file) === "." ? "" : dirname(file);
    // oxlint-disable-next-line no-await-in-loop -- one small file each
    for (const rule of await readRules(join(worktreePath, file))) {
      rules.push(anchorRule(rule, folder));
    }
  }
  // The exclude file lives in the repository's git dir, which a
  // linked worktree only points at. Its rules read like the root's.
  let excludePath = "";
  try {
    excludePath = (
      await run(worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude",
      ])
    ).trim();
  } catch {
    // No git dir to ask: the .gitignore files alone.
  }
  if (excludePath !== "") rules.push(...(await readRules(excludePath)));
  return [...new Set(rules)].slice(0, IGNORE_RULES_LIMIT);
}
