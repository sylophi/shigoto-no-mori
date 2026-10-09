// Go's aliases, folded before parsing, since effect/cli takes one per
// command: a namespace's, a worktree verb's (at the top level and after
// `worktrees`), and a project verb's, which differ: `rm` alone removes
// a worktree, after `projects` a project.
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
  rm: "remove",
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

// A command's own name, whichever alias it was called by.
export const commandName = (name: string) =>
  NAMESPACES[name] ?? VERBS[name] ?? name;

// A project verb's own name.
export const projectVerb = (name: string) => PROJECT_VERBS[name] ?? name;

export function canonical(args: ReadonlyArray<string>) {
  const [first, ...more] = args;
  if (first === undefined) return args;
  const command = commandName(first);
  const [verb, ...after] = more;
  if (verb === undefined) return [command];
  if (command === "worktrees") return [command, VERBS[verb] ?? verb, ...after];
  if (command === "projects") return [command, projectVerb(verb), ...after];
  return [command, ...more];
}
