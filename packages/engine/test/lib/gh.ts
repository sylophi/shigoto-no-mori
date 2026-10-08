// gh as a test scripts it, for the parity harness and the terminal's
// tests alike.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./sandbox.ts";

// A gh that answers each call with the first rule whose arguments start
// with the rule's (`*` matches any one), and logs every call. Both sides
// must ask GitHub the same things in the same order, so the log is part
// of what a case compares.
export type GhRule = {
  readonly args: ReadonlyArray<string>;
  readonly out?: unknown;
  readonly err?: string;
  readonly code?: number;
};

export const ghScript = (
  box: Pick<Sandbox, "home" | "fakeBin">,
  rules: ReadonlyArray<GhRule>,
) => {
  const bin = join(box.home, "bin");
  mkdirSync(bin, { recursive: true });
  const rulesFile = join(bin, "gh-rules.json");
  const logFile = join(bin, "gh-calls.log");
  writeFileSync(rulesFile, JSON.stringify(rules));
  writeFileSync(logFile, "");
  writeFileSync(
    join(bin, "fake-gh.mjs"),
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const rules = JSON.parse(readFileSync(${JSON.stringify(rulesFile)}, "utf8"));
const rule = rules.find((r) => r.args.every((a, i) => a === "*" || a === args[i]));
if (!rule) { process.stderr.write("fake gh: unexpected " + args.join(" ")); process.exit(2); }
if (rule.out !== undefined) process.stdout.write(typeof rule.out === "string" ? rule.out : JSON.stringify(rule.out));
if (rule.err !== undefined) process.stderr.write(rule.err);
process.exit(rule.code ?? 0);
`,
  );
  box.fakeBin(
    "gh",
    `exec node ${JSON.stringify(join(bin, "fake-gh.mjs"))} "$@"`,
  );
  // The calls since the last look.
  return () => {
    const calls = readFileSync(logFile, "utf8");
    writeFileSync(logFile, "");
    return calls;
  };
};

export const pr = (
  number: number,
  head: string,
  base = "main",
  extra: Record<string, unknown> = {},
) => ({
  number,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  url: `https://github.com/me/repo/pull/${number}`,
  baseRefName: base,
  headRefName: head,
  isCrossRepository: false,
  ...extra,
});

export const settingsRule = (
  allowed: { merge?: boolean; squash?: boolean; rebase?: boolean },
  autoMerge = false,
): GhRule => ({
  args: ["api", "graphql", "-F", "owner={owner}"],
  out: {
    data: {
      repository: {
        mergeCommitAllowed: allowed.merge ?? false,
        squashMergeAllowed: allowed.squash ?? false,
        rebaseMergeAllowed: allowed.rebase ?? false,
        autoMergeAllowed: autoMerge,
      },
    },
  },
});
