import type * as Command from "effect/cli/Command";

// The aliases, folded before parsing, since effect/cli takes one per
// command: a namespace's, a worktree verb's (at the top level and after
// `worktrees`), and a project verb's, apart from the worktree verbs'
// (`remove` is a worktree's `rm`, never a project's).
const VERBS: Readonly<Record<string, string>> = {
  ls: "list",
  l: "list",
  st: "status",
  "auto-pull": "autopull",
  new: "create",
  n: "create",
  remove: "rm",
  mv: "move",
  c: "cd",
  o: "open",
};
const PROJECT_VERBS: Readonly<Record<string, string>> = {
  ls: "list",
};
const NAMESPACES: Readonly<Record<string, string>> = {
  worktree: "worktrees",
  wt: "worktrees",
  w: "worktrees",
  project: "projects",
  p: "projects",
  launcher: "launchers",
  agent: "agents",
};

export const commandName = (name: string) =>
  NAMESPACES[name] ?? VERBS[name] ?? name;

export const projectVerb = (name: string) => PROJECT_VERBS[name] ?? name;

// `args` with the aliases folded. After the worktrees namespace
// (`worktrees`), a word that names none of its verbs, a flag included,
// is `switch`'s.
export function canonical(
  args: ReadonlyArray<string>,
  worktrees: Command.Command.Any,
) {
  const [first, ...more] = args;
  if (first === undefined) return args;
  const command = commandName(first);
  const [verb, ...after] = more;
  if (verb === undefined) return [command];
  if (command === "worktrees") {
    const named = VERBS[verb] ?? verb;
    return worktrees.subcommands.some(({ commands }) =>
      commands.some(({ name }) => name === named),
    )
      ? [command, named, ...after]
      : [command, "switch", ...more];
  }
  if (command === "projects") return [command, projectVerb(verb), ...after];
  return [command, ...more];
}
