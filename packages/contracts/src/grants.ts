// What the command switch ("Allow control from other devices") hands to
// the account's other devices, as the lines the switch's panel shows,
// grouped the way a person weighs them. Every remote gated call names
// the line that covers it (the Grant annotation, contract.ts), so a new
// command cannot reach other devices without a line saying so.
export const GRANTS = {
  runCommands: {
    title: "Run commands as you",
    detail:
      "Edit and run setup, teardown and package.json scripts, and type into their terminals.",
  },
  changeCode: {
    title: "Change your code",
    detail:
      "Create, delete and move worktrees, commit, discard changes, push (force push too) and merge pull requests with this machine's Git and GitHub credentials.",
  },
  browseFiles: {
    title: "Browse your files",
    detail:
      "List folders anywhere on this machine, read any file in its worktrees, and add or clone projects into it.",
  },
  reachServers: {
    title: "Reach local servers",
    detail: "Forward ports to anything listening on this machine's localhost.",
  },
  changeApp: {
    title: "Change the app",
    detail:
      "Edit settings, install the CLI and shell hooks, run health check repairs, install updates and move the data folder.",
  },
} as const;

export type GrantId = keyof typeof GRANTS;
