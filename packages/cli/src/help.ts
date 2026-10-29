// The help: a catalog of usage lines, each with a one-line description
// and a dim elaboration, laid out in one aligned column. Every worktree
// command also takes -p <project>, said once in the prose instead of on
// every usage line. Help is data; layout and color are computed.
import type { flavorNames } from "@shigomori/engine/flavor";
import { byPlatform } from "@shigomori/engine/platform";
import { commandName, projectVerb } from "./aliases.ts";
import { splitAtDashes } from "./argv.ts";
import { styles, type Styles } from "./output.ts";

// A usage line, the description beside it, and the detail below it.
type Item = readonly [usage: string, desc: string, detail: string];

type Names = ReturnType<typeof flavorNames>;

const catalog = (names: Names) => {
  const bin = names.binaryName;
  return {
    general: [
      [
        "cd [<name>]",
        "Open a subshell in any worktree",
        "Picks a project, then a worktree. Exit the shell to return. With shell integration (see `shell`), your current shell cd's instead.",
      ],
      [
        "run [<script>] [<args>...]",
        "Run a package.json, justfile or Makefile script here",
        "Works inside any registered project's checkout or worktree. The scripts are package.json's, then the justfile's recipes as `just <recipe>` and the Makefile's targets as `make <target>`. Detects the package manager from the lockfile (bun/pnpm/yarn/npm), sets the SHIGOMORI_* script env, counts the run in the shared use log, and execs `<manager> run <script>` (or `just <recipe>`, `make <target>`) at the worktree root, so output, signals, and the exit code are the script's own. Extra args pass through to the script (put dashed ones after --). With no script, lists them; with --json that list is {ok, packageManager, scripts: [{name, command, file, label}] in file order, usage: {<name>: {lastUsed, recentCount}}, sort, order}, where packageManager is null without a package.json, file and label are the file a script comes from and its name there (\"build\" for \"just build\"), and sort and order are the project's saved script sort and manual order.",
      ],
      [
        "launchers [-p <project>] [--catalog]",
        "List a project's launcher row",
        "The tools `open` offers, in the app's order (recent use, then label), hidden ones left out. --json prints {ok, entries: [{kind, id, label, available?}], hiddenCount, usage: {<id>: {lastUsed, recentCount}}}, kind being detected, custom or web. " +
          '--catalog lists every tool the app knows instead, installed or not, with no project needed: --json prints {ok, apps: [{kind: "detected", id: "app:<id>", label, available}]}, sorted by label case-insensitively.',
      ],
      ...byPlatform<{ darwin: Item[]; linux: Item[] }>({
        darwin: [["app", "Open the Shigoto no Mori app", ""]],
        linux: [
          [
            "login",
            "Sign this machine in to your account",
            "Prints a link and a code: open the link on another device, sign in there if you need to, and approve. This machine then joins your account as one of your devices, under its hostname. Needs the host running.",
          ],
          [
            "logout",
            "Sign this machine out of your account",
            "Removes this machine from your devices and drops its credential. Offline, it signs out here anyway, and the hub is told the next time the host starts.",
          ],
        ],
      }),
      [
        "devices [-p <project>]",
        "List your other devices",
        `The machines signed in to your account, by the names --to and --from take. Inside a project (or with -p) each says whether it can take part in a send, bring or mirror, and if not, why. ${byPlatform({ darwin: "Needs the app open.", linux: "Needs the host running, signed in (`login`)." })}`,
      ],
      [
        "devices share [on|off]",
        "Share this device with your other devices",
        "Off, your other devices can't see or do anything here. Without on or off, prints the switch. --json prints {ok, share, control, keepReachable}, as the other switches do.",
      ],
      [
        "devices control [on|off]",
        "Let your other devices act on this one as you",
        "Runs their commands here: scripts and terminals, worktrees and mirrors into this device, files, ports and settings. Needs sharing on and an account signed in. Off by default, and off again after a sign-out.",
      ],
      ...byPlatform<{ darwin: Item[]; linux: Item[] }>({
        darwin: [
          [
            "devices reachable [on|off]",
            "Keep this device reachable",
            "Opens the app at login and again after a crash it can recover from.",
          ],
        ],
        // The service keeps it reachable (`service`).
        linux: [
          [
            "devices rename <name>",
            "Rename this machine on your account",
            "The name your other devices list it by, and --to and --from take.",
          ],
          [
            "devices icon [<icon>]",
            "Pick this machine's icon on your account",
            "Without one, prints the icon and the ones to pick from.",
          ],
          [
            "devices remove <device> [--yes]",
            "Remove another device from your account",
            "<device> is its name or id, or the start of either. It's signed out there, and its mirrors and forwards here end. Asks first, unless --yes.",
          ],
        ],
      }),
      byPlatform<{ darwin: Item; linux: Item }>({
        darwin: [
          "update [--check]",
          "Update the app to the latest release",
          "Checks GitHub releases, downloads, verifies and installs without opening the app (the linked CLI updates with it), restarting a running app into the new version. --check only reports. A prerelease build takes any later prerelease or release, a release build only a later release.",
        ],
        linux: [
          "update [--check]",
          "Update the host to the latest release",
          "Checks GitHub releases, downloads, verifies and installs it (the linked CLI updates with it), restarting a running host into the new version. --check only reports. A prerelease build takes any later prerelease or release, a release build only a later release.",
        ],
      }),
      [
        "doctor [--fix] [--yes]",
        "Check the installation and data dir",
        `Checks the environment, the data dir, each project, and the processes a crashed ${byPlatform({ darwin: "app", linux: "host" })} left running. Exits non-zero when anything failed. --fix applies only the safe repairs, asking before each one that deletes something (--yes skips the prompts); anything else is reported. A v2 data dir the app hasn't moved to v3 yet is read as v2 left it, and --fix moves it, as the app's start does.`,
      ],
      [
        "data [move <folder> | reset]",
        "Show or move the data folder",
        `Prints where it is. move puts it inside <folder> under its own name, and reset puts it back where it starts, as Settings' Data location does. Either stops every running script and restarts the ${byPlatform({ darwin: "app", linux: "host" })} into the new place. Refused while SHIGOMORI_DATA_DIR sets it. --json prints {ok, dataDir, dataDirSource, atDefaultDataDir}, and after a move {ok, dataDir}, null for a reset.`,
      ],
      byPlatform<{ darwin: Item; linux: Item }>({
        darwin: [
          "nuke --yes [--keep-app]",
          "Take everything of this build off the machine",
          "What Settings' Danger zone does, with no window: the app in this command's bundle is quit, then started to remove its worktrees, this command's links, the shell and agent hooks, this device from your account and its login item, then its data folder, its own folder, logs, preferences and keychain item. Then the bundle itself (--keep-app keeps it). Runs only from a packaged build's command. Exits non-zero when something stayed, saying what.",
        ],
        linux: [
          "nuke --yes",
          "Take everything of this build off the machine",
          "The host's service is stopped and taken out, then the host is started to remove its worktrees, this command's links and the shell and agent hooks, then its data folder, logs and install. Runs only from an installed build's command. Exits non-zero when something stayed, saying what.",
        ],
      }),
      [
        "help [<command>] [--all]",
        "Show help",
        "help <command> documents one command, --all prints every command at once.",
      ],
    ],

    worktrees: [
      [
        "worktrees list [--all] [--remote] [--from <device>] [--identities]",
        "List worktrees",
        "All projects when outside one, or with --all; -p <project> picks one from anywhere. --remote lists this project's worktrees on your other devices (--from narrows it to one), and needs the app open. " +
          "--json prints one array of rows, primary first within each project. A row is the app's Worktree document plus projectName: id, projectId, name, branch, path, ahead, behind, hasUpstream, hasRemote, divergedClean, behindPrimary, unpushedCount, primaryRef, primaryBranch, mergedIntoPrimary, changedCount, lastChangeAt, createdAt, recentCommits, isPrimary, isExternal, detached, shelved, autoPull, agentWorking, and title and description when `describe` set them (the worktree's own, never a pull request's). --worktree-id <id> narrows the array to that one row. " +
          "Listing full rows also takes a shelved worktree back off the shelf once it has been worked in since it was shelved (an edit, a new or deleted file, a commit; not the changes it was shelved with, nor an auto-pull fast-forward), and the row says shelved: false. " +
          "--identities is the cheap form, with no git probe per worktree (only git's worktree list and the registry marks): the same scope, order and array, each entry {id, projectId, name, branch, path, isPrimary, isExternal, detached, shelved, autoPull, agentWorking}. Add --primary-ref for each project's primaryRef and primaryBranch (left out when it has none), resolved once per project. " +
          "A bare repository has no primary checkout; otherwise the checkout at the project path is the primary (the first one listed when none sits there).",
      ],
      [
        "worktrees status [<name>] [--no-pr]",
        "Status card for one worktree",
        "Where the worktree you're standing in stands: its title, branch, base, changes, stash, last commit, ports, scripts, PR. The PR lookup needs gh and degrades to a note rather than stalling the card. --no-pr skips it.",
      ],
      [
        "worktrees switch [<name>]",
        "Open a subshell in this project's worktrees",
        "Like cd without the project menu. Exit the shell to return, or cd in place with shell integration.",
      ],
      ["worktrees path [<name>]", "Print a worktree's directory", ""],
      [
        "worktrees create [<name>] [-b <branch-name>] [--base <ref>] [--no-cd] [--no-setup] [--no-clone]",
        "Create a worktree",
        "On a new branch named -b (default: the worktree name), forked from --base (default: the default branch). Tracked files are cloned (copy-on-write) from an existing checkout wherever it has them unchanged, and git writes the rest (--no-clone has git write them all). Run from an agent's shell, it binds the agent's session to the new worktree (see agents). Runs carry-over, the setup script (--no-setup skips it), and port provision, then drops into the new worktree: a subshell, or your own shell with shell integration (--no-cd, --json, and scripts skip it).",
      ],
      [
        "worktrees rm [<name>] [--stack] [-f] [--keep-branch]",
        "Remove a worktree",
        "Teardown, release port, delete the branch per app settings. --stack also removes the worktrees of the merged layers under it in its PR stack (the cleanup half of land --stack, for a stack that has landed, and an open PR is refused). The removal guards cover all of them first.",
      ],
      [
        "worktrees done [<name>] [-f]",
        "Post-merge cleanup",
        "Lands the checkout back on the primary branch and deletes the merged one. Refuses without -f a branch that isn't merged, one with commits its merged PR never had (it names them), and one GitHub couldn't be asked about.",
      ],
      [
        "worktrees pr [<name>]",
        "Open the worktree's PR in the browser",
        "The PR for the worktree's branch, any state. Errors when the branch has none.",
      ],
      [
        "worktrees merge [<name>] [-m <method>] [--stack]",
        "Merge the worktree's PR via gh",
        "Method follows the repo's settings unless -m overrides. On a repo that allows auto-merge, a PR still waiting on its base branch's rules (checks running, a review missing) gets auto-merge enabled instead. It then waits for GitHub to merge the PR, as it does for a PR a merge queue took, and stops with an error when the PR needs attention instead (a required check failed, a conflict, changes requested, auto-merge turned off). --stack lands the PR and every open PR under it in its stack, bottom first, and doesn't wait on a queue.",
      ],
      [
        "worktrees land [<name>] [-m <method>] [--stack] [-f] [--keep-branch]",
        "Merge the PR, then clean up",
        "merge + rm in one step (done when landing the primary checkout), fast-forwarding the checkout that has the PR's base branch out in between. An already-merged PR skips straight to cleanup. A PR that doesn't merge on the spot (auto-merge enabled, or a merge queue took it) is waited on as merge does, then cleaned up. One that needs attention instead stops it with an error and nothing removed. A stack a merge queue took stops before the cleanup, and running land again once it has merged does the rest. A branch with commits the PR doesn't have (made after its last push) is refused before anything merges, naming them, unless -f or --keep-branch. " +
          "--stack lands the PR with every open PR under it in its stack (merge --stack), then removes every worktree whose branch landed, the lower layers' included. A PR that sits on another open PR is refused without it. The removal guards cover all of them before anything merges.",
      ],
      [
        "worktrees adopt [<name-or-path>] [-f]",
        "Convert an external worktree to managed",
        "Moves it into the layout and runs the lifecycle. Refuses dirty worktrees without -f.",
      ],
      [
        "worktrees setup [<name>]",
        "Re-run the setup script",
        "Also re-provisions the port-pool port.",
      ],
      [
        "worktrees dirty <capture|apply> [<name>] [-f]",
        "Snapshot or restore uncommitted changes",
        "The device-sync primitive. capture commits the worktree's dirty state -- untracked files " +
          "included, ignored files excluded, what is staged kept apart -- to a hidden " +
          "ref (refs/shigomori/dirty/<id>, one per worktree, overwritten each time) without touching " +
          "the real index; on a clean worktree it just removes any stale capture. apply restores a " +
          "capture, staged and unstaged as they were, onto a clean worktree whose HEAD matches the capture's parent, then " +
          "deletes the ref. -f skips apply's clean check only. git still refuses where local changes " +
          "overlap the capture, and a HEAD mismatch always refuses (sync the branch first).",
      ],
      [
        "worktrees send [<name>] [--to <device>]",
        "Move a worktree to another device",
        "The app's \"Transplant to…\". --to takes a device's name or id, or the start of either, and can be left off when only one device qualifies (`devices` says which). --leave-out nothing|gitignored picks which ignored files stay behind (default: the project's saved rule). --setup / --no-setup overrides whether the copy runs the setup script. --source keep|shelve|teardown decides what becomes of the original (default keep). teardown also deletes ignored files that did not cross. A device with no checkout of the repo takes it too, cloning the repo first into the folder --clone-into <dir> names there (a leading ~ is that device's home, so quote it; a path in this device's home reads as the same path in that one's), by default the checkout's own place with the two homes swapped. A checkout of the repo already in that folder is used as it is. Left off, --to prefers a device that holds the repo. Needs the app open, and finishes there even if interrupted. Exits 3 when the worktree landed but something after it didn't hold.",
      ],
      [
        "worktrees bring <worktree> [--from <device>]",
        "Move a worktree here from another device",
        "send, the other way round. <worktree> is the other device's folder name or branch (`list --remote` shows them), and --from is only needed when several devices have it. Same options as send. Prints the new worktree's path.",
      ],
      [
        "worktrees mirror [<name>] [--to <device> | --from <device>]",
        "Keep a worktree in step on two devices",
        'send or bring that stays: files, commits, staging and branch moves follow each other both ways until unmirror. With --to (or neither) the copy lands on the other device. With --from, <name> is the other device\'s worktree and the copy lands here, at the path printed. The mirror runs on the device holding the original, so --from asks the other device to run it, and it writes the copy here: this device needs "Allow control from other devices" and "Share with other devices" on. Asking again answers with the running mirror. Takes --leave-out and --setup / --no-setup like send, and with --to (or neither) --clone-into.',
      ],
      [
        "worktrees unmirror [<name>] [-f]",
        "Stop mirroring and remove the copy",
        "Removes the copy, wherever it is, and never the original. Refuses until both sides hold the same commits. -f stops anyway.",
      ],
      ["worktrees mirrors", "List the mirrors this device is part of", ""],
      [
        "worktrees shelve / unshelve [<name>]",
        `Toggle the app's "out of focus" flag`,
        "A shelved worktree comes back off the shelf on its own once it is worked in: the next full listing (the app's sidebar, `worktrees list`) that finds an edit, a new or deleted file or a commit made since the shelve unshelves it.",
      ],
      [
        "worktrees describe [<name>] [-t|--title <title>] [-d|--description <text> | --description-file <path|->]",
        "Set or show a worktree's title and description",
        "What the work is, like a pull request's title and body: the app shows the title in place of the branch until the branch has a pull request from this repository, whose title it shows then in any state, and the description on the worktree page. Set them once the work has a purpose and again whenever it changes. Each flag replaces only its own field, and an empty value clears it. --description-file - reads stdin. With no flags it prints the worktree's own, or its open pull request's. While the branch has an open pull request from this repository (not a fork's branch of the same name), its title and body are the worktree's, and describe edits the PR's instead (a PR's title can't be cleared). When gh can't tell whether there is one (other than for a repo with no GitHub remote, or a gh not signed in), it changes nothing. External worktrees have none (adopt one first). They travel with send, bring and mirror. --json prints {ok, worktree: <row>, pullRequest}, pullRequest the PR it edited (null when it wrote the worktree's own), or {ok, title, description, pullRequest} with no flags, where title and description are the worktree's own and pullRequest the open PR that overrides them.",
      ],
      [
        "worktrees autopull [on|off] [<name>]",
        "Set or show the app's auto-pull mark",
        "While on, the running app fast-forwards the worktree onto its upstream after each background fetch, as long as it has no local commits, changes or running scripts. Any checkout can carry it, the primary included. With no on/off it reports the state. --json prints {ok, worktree: <row>} (a `list` row).",
      ],
      [
        "worktrees move [<name>] <new-path>",
        "Move a worktree's checkout",
        "git worktree move (a copy instead when the destination is on another volume), then carries what is keyed by the worktree's path-derived id (shelf and auto-pull marks, bound agent sessions, its title, description and ports, a pending dirty capture) over to the new id. Refuses the primary and an existing destination, and while the running app has scripts or terminals open there. Prints the new path; --json prints {ok, worktree: <row>, previousId}.",
      ],
      [
        "worktrees rename [<name>] <new-name>",
        "Rename a worktree's folder",
        "A move to the same parent under <new-name>, which is checked as create checks a custom name: a valid folder name, not a reserved one, not one another worktree of the project has. Everything a move carries comes along, and as with any move the worktree gets a new id and new port-pool ports, and a bound agent session's transcript stays with the old folder. Refuses the primary, and while the running app has scripts or terminals open there. Prints the new path; --json prints {ok, worktree: <row>, previousId}.",
      ],
      [
        "worktrees open [<tool>] [<name>]",
        "Launch a launcher-row tool in a worktree",
        "Finder, editors, custom commands. <tool> is a label, a bare catalog id (finder) or a full launcher id (app:vscode, custom:<id>, web:github), case-insensitive. With no tool, shows the row as a menu. " +
          "--project-id <id> --worktree-id <id> address the worktree exactly (the primary included); put the tool after --. --json prints {ok, launcher, worktree}; an unknown tool fails with code unknown-launcher.",
      ],
      [
        "worktrees edit <file> [<name>]",
        "Open a worktree's file in your editor",
        "The editor set in config (editor), or the file's default app while it's unset. A relative <file> reads from cwd in the worktree you're in, and from the root of one you name. " +
          "--project-id <id> --worktree-id <id> address the worktree exactly, with the file after --. --json prints {ok, path}, and a file that isn't there fails with code missing-file.",
      ],
      [
        "worktrees link [<name>]",
        "Print a link that opens the worktree in the app",
        "A " +
          names.alias +
          "://open/devices/<id>/projects/<id>/worktrees/<id> URL, for a chat, a note or a script. It names this device, so it opens this machine's worktree wherever it's clicked. Add /diff, /files or /pr-diff for that page. `open` it to open it now (the installed app launches if it isn't running). --project-id <id> --worktree-id <id> address the worktree exactly. --json prints {ok, url, worktree}.",
      ],
    ],

    projects: [
      [
        "projects list [--refresh-icons]",
        "List registered projects",
        "Registry entries and, when that integration is on, terrier-registered repos, in the sidebar's manual order. --json prints one array of rows: id, name, path, source (\"terrier\" or absent), pathExists, identity (the cross-device repo key, or null), lastUsed and recentCount (the app's project use log), icon ({path, mime}, or null) and hue (always null). Icons resolve through the shared icon cache; --refresh-icons re-scans projects it remembers as icon-less.",
      ],
      [
        "projects icon [<name>]",
        "Print a project's icon file",
        "--json prints {mime, base64}, or null when the project has no icon.",
      ],
      [
        "projects add [<path>] [--all] [--[no-]terrier]",
        "Register a repo",
        "The repo at <path> (default .). --all registers every repo beneath it after confirmation (--yes skips). " +
          "While the terrier integration is on, it registers the repo in terrier too (--no-terrier skips). " +
          "--terrier registers it there whatever the setting.",
      ],
      [
        "projects clone <project> [--from <device> | --to <device>] [--into <dir>]",
        "Set up a project on a device that lacks it",
        "Clones another device's project here, or with --to, this device's project onto that device. " +
          "<project> is the other device's project: its name, its path there, or its id (an unknown name lists what is there). With --to it is one of this device's. " +
          "--from and --to take a device's name or id, or the start of either. --from can be left off when only one device has the project. " +
          "The repo is cloned from the source's checkout over the device link, so it needs no credentials, and gets the same remote. " +
          "It goes in the folder --into <dir> names (a leading ~ is the receiving device's home), by default the checkout's own place with the two homes swapped. " +
          "A checkout of the repo already in that folder is registered as it is. " +
          "The project then takes the source's settings: scripts, launchers, carry-over and the rest, bar its port base and a custom worktree folder, " +
          "and the files its carry-over names (an ignored .env, say) come from the source's checkout. " +
          "Refused when the receiving device already has the repo. Needs the app open on both, each sharing, and the other device accepting commands from this one (with --to, each from the other). " +
          "Prints the checkout's path when it lands here. Exits 3 when the clone stands but the settings or those files didn't come along. --json prints {ok, project, device, settings: {copied, error}, files: {crossed, conflicts, error}, caveats}.",
      ],
      [
        "projects unregister [<name-or-path>]",
        "Unregister a project",
        "Worktrees stay on disk. While the terrier integration is on, a repo terrier lists is unregistered there too. " +
          "Prompts for confirmation (--yes skips). " +
          "When two projects share a name, unregister by path (which also " +
          "reaches an entry whose repo has since moved away).",
      ],
      [
        "projects delete [<name-or-path>]",
        "Delete a project from disk",
        "Removes its worktrees as rm does, then deletes the repo's folder and unregisters it as unregister does. " +
          "Refused before anything goes while any checkout has uncommitted changes, or when the folder holds your home folder, the data folder or another project. " +
          "Prompts for confirmation (--yes skips).",
      ],
      [
        "projects relocate [<name-or-path>] <new-path>",
        "Point a project at its moved repo",
        "For a repo moved or renamed by hand: refused while the old path is still there. The project keeps its config and state " +
          "(terrier's entry for it moves too), and its worktrees are reconnected to the repo (`git worktree repair`), including any that moved with it. " +
          "After a rename, managed worktrees move to the folder named after the new one. " +
          "--json prints {ok, project}, project being a `projects list` row.",
      ],
      [
        "projects config [<command>] [args]",
        "Show or set per-project config",
        "Bare: prints the project's settings. The global config's verbs work here too, scoped by -p: " +
          "list, get <key>, set <key> <value>, unset <key>, edit, read. Keys: `" +
          bin +
          " projects config list`. Structured lists get element verbs: launcher add " +
          "<label> <command> / rm <label-or-id>, and carryover add <path> [--copy|--symlink] " +
          "/ rm <path> (add upserts, so re-adding switches the mode). The flags --setup <cmd>, " +
          `--teardown <cmd>, and --default-branch <ref> are shorthands: "" clears a ` +
          "script, and default-branch can't be cleared.",
      ],
    ],

    config: [
      [
        "config list",
        "Show every setting",
        "Effective values, with (default) marking keys that aren't set. --json prints {ok, settings: [{key, value, set}]}.",
      ],
      [
        "config read",
        "Print the settings as stored (--json)",
        "{ok, config: {...}}, unknown keys included and no defaults filled in ({} when none are set). projects config read answers the same for the project's settings, with config null when the project has none.",
      ],
      ["config get <key>", "Print one setting's effective value", ""],
      [
        "config set <key> <value>",
        "Change a setting",
        "Booleans accept true/false, on/off, yes/no, 1/0. Setting a key to its default removes " +
          "it from the stored settings, same as the app.",
      ],
      ["config unset <key>", "Reset a setting to its default", ""],
      [
        "config launcher [<command>]",
        "Manage global custom launchers",
        "add <label> <command> adds one, rm <label-or-id> removes one, bare lists them. " +
          "Per-project launchers: `" +
          bin +
          " projects config launcher`.",
      ],
      [
        "config edit",
        "Open the settings in your editor",
        "$VISUAL or $EDITOR, at a terminal. Saved when the editor quits.",
      ],
    ],

    agents: [
      [
        "agents install [<harness>...]",
        "Install the hooks that report agent sessions",
        "Adds hook entries that run `agents event` to each named harness's own hooks file (claude: Claude Code's settings.json, codex: Codex's hooks.json), every harness found on this machine by default. Leaves the rest of the file alone, and replaces entries an earlier build wrote. Codex runs a hook only once it is trusted: review them with /hooks in Codex. --json prints {ok, harnesses: [<status>]}, every harness's, like status.",
      ],
      [
        "agents uninstall [<harness>...]",
        "Remove those hooks",
        "Only entries it recognizably wrote. --json prints {ok, harnesses: [<status>]}, every harness's.",
      ],
      [
        "agents status",
        "Show each harness's hooks",
        "--json prints {ok, harnesses: [{id, label, detected, path, hooks, trusted?}]}: detected says the harness's config dir exists, path is its hooks file, hooks is installed, outdated (install again) or missing, and trusted (Codex, once installed) whether it trusts every one of them.",
      ],
      [
        "agents bind [<name>] [--harness <id> --session <id>]",
        "Bind an agent session to a worktree",
        "A session is bound to one worktree at a time, and binding it elsewhere moves it. Without the flags it binds the session whose shell runs the command (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID). That also happens on its own: any command run inside a managed worktree from such a shell binds the session there, and `create` binds it to the new worktree. The primary checkout and external worktrees can't be bound. --json prints {ok, worktree: <row>}.",
      ],
      [
        "agents unbind [--harness <id> --session <id>]",
        "Unbind an agent session",
        "Without the flags, the session whose shell runs the command. It stays unbound until a command, or the session's next hook event from inside a managed worktree, binds it again (see bind). --json prints {ok, unbound}, unbound false when it wasn't bound.",
      ],
      [
        "agents idle [<name>]",
        "Mark a worktree's agent sessions idle",
        "For a turn whose end no hook reported (Claude Code reports none when it is interrupted). --json prints {ok, worktree: <row>}.",
      ],
      [
        "agents resume [<name>] --harness <id> --session <id>",
        "Resume an agent session in a terminal",
        "Runs the harness's own resume (claude --resume, codex resume) in the worktree, in the terminal set in config (terminal). --json prints {ok}.",
      ],
      [
        "agents event --harness <id>",
        "Report a session's lifecycle event (stdin)",
        "What the installed hooks run, and what any other harness can call the same way: one JSON object on stdin with hook_event_name and session_id (and cwd, which binds an unbound session started in a managed worktree). UserPromptSubmit sets the session working, PermissionRequest waiting on the user, PostToolUse (or PostToolUseFailure) for the tool it asked about working again once no prompt is open, Stop, StopFailure, Interrupt, SessionEnd and an idle_prompt Notification idle. With agent_id (a Codex subagent) the event is that subagent's, and its SubagentStop unbinds it. Prints nothing and exits 0 whatever happens.",
      ],
    ],

    shell: [
      [
        "shell install [<shell>]",
        "Hook shell integration into your shell config",
        "A guarded eval line in .zshrc/.bashrc (marker-fenced) or a fish conf.d drop-in. Defaults to your login shell.",
      ],
      [
        "shell uninstall",
        "Remove the hook from every shell's config",
        "Only removes hooks it recognizably wrote. Edited blocks are reported and left alone.",
      ],
      ["shell status", "Show hook and session state", ""],
      [
        "shell init <zsh|bash|fish>",
        "Print the wrapper the hook evals",
        "A function shadowing the command: it runs the real binary, then cd's to the path the binary reports.",
      ],
    ],

    service: [
      [
        "service install",
        "Run this machine's host as a service",
        "Writes the systemd user unit that runs the installed version's host, from boot and again whenever it exits but for a stop, and starts it. Turns on lingering where you may, so it runs with no one logged in. --json prints {ok, lingering}.",
      ],
      [
        "service uninstall",
        "Stop the host and remove its service",
        "The install stays: `service install` runs it again.",
      ],
      ["service start", "Start the host", ""],
      [
        "service stop",
        "Stop the host",
        "Until the next start, or the next boot.",
      ],
      [
        "service restart",
        "Restart the host",
        "It stops what it ran, and what an earlier run left behind as it starts.",
      ],
      [
        "service status",
        "Show whether the host runs, and when it starts",
        "--json prints {ok, unit, installed, enabled, running, pid, version, lingering}, version being the installed one (null with none) and pid 0 when it isn't running.",
      ],
      [
        "service logs [-f, --follow]",
        "Show what the host has logged",
        "The last 200 lines of its journal, or every line as it comes with --follow.",
      ],
    ],

    flags: [
      ["--json", "Machine-readable output", "NDJSON progress for create."],
      ["--verbose", "Diagnostics on stderr", ""],
      [
        "-h, --help",
        "Show this help",
        "After a command, documents that command.",
      ],
    ],

    environment: [
      [
        "SHIGOMORI_DATA_DIR",
        "Override the data dir entirely",
        "Without it, the data dir comes from ~/.config/" +
          names.configDir +
          "/" +
          names.pointer +
          " when that file exists (one line holding an absolute path, honoring $XDG_CONFIG_HOME), else ~/" +
          names.dataDir +
          (names.legacyDataDir === null
            ? "."
            : " (or a pre-2.0 ~/" +
              names.legacyDataDir +
              " that still holds state)."),
      ],
    ],
  } satisfies Record<string, ReadonlyArray<Item>>;
};

type Catalog = ReturnType<typeof catalog>;

// One row per namespace: the items its subcommands resolve against,
// the pointer line the base page renders, the blurb its own page opens
// with, and its own alias fold.
const namespacesOf = (bin: string, items: Catalog) => [
  {
    name: "worktrees",
    desc: "Worktree commands",
    shortAlias: "w or wt",
    blurb: `The worktrees prefix is optional: ${bin} rm == ${bin} wt rm. All commands accept -p <project>.`,
    items: items.worktrees,
    canon: (name: string) => name,
  },
  {
    name: "projects",
    desc: "Project commands",
    shortAlias: "p",
    blurb:
      "Manage registered projects. A project is addressed by name, or by its path when the name isn't unique.",
    items: items.projects,
    canon: projectVerb,
  },
  {
    name: "config",
    desc: "Global settings",
    shortAlias: "",
    blurb: `Global settings, stored in the data dir. Keys and current values: \`${bin} config list\`. Per-project settings live under \`${bin} projects config\`.`,
    items: items.config,
    canon: (name: string) => name,
  },
  {
    name: "agents",
    desc: "Agent integrations: which session works where",
    shortAlias: "",
    blurb:
      "Coding agents' sessions bound to worktrees, and the state their harness's hooks report (working, waiting on you, idle). While a bound session works, the app keeps the worktree on the Agent working shelf (a sidebar setting).",
    items: items.agents,
    canon: (name: string) => name,
  },
  {
    name: "shell",
    desc: "Shell integration: cd without subshells",
    shortAlias: "",
    blurb: `Shell integration makes cd and create move your current shell into the worktree instead of nesting a subshell. install hooks it into your shell config. The hook evals \`${bin} shell init <shell>\`, whose wrapper function runs the real binary and cd's to the path it reports. Without the hook, those commands keep opening a subshell.`,
    items: items.shell,
    canon: (name: string) => name,
  },
  // A Mac's app is its host, so only Linux has one to run as a service.
  ...byPlatform({
    darwin: [],
    linux: [
      {
        name: "service",
        desc: "The host, run by systemd",
        shortAlias: "",
        blurb:
          "The host is what serves this machine to the terminal and to your other devices. On Linux it runs as a systemd user unit, from the version installed.",
        items: items.service,
        canon: (name: string) => name,
      },
    ],
  }),
];

const INDENT = 2;
const MAX_INLINE_USAGE = 34;

const pad = (n: number) => " ".repeat(Math.max(n, 0));
const width = (text: string) => [...text].length;
const fieldsOf = (usage: string) => usage.split(" ").filter((f) => f !== "");

function wrapText(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && width(line) + 1 + width(word) > Math.max(columns, 20)) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

// Token by token: the command and its subcommands cyan, <placeholders>
// yellow, flags green, brackets and separators dim.
function colorUsage(usage: string, paint: Styles): string {
  let out = "";
  const chars = [...usage];
  let i = 0;
  const until = (stop: (c: string) => boolean) => {
    let j = i;
    while (j < chars.length && !stop(chars[j] as string)) j++;
    return j;
  };
  while (i < chars.length) {
    const c = chars[i] as string;
    if (c === "<") {
      const j = Math.min(until((x) => x === ">") + 1, chars.length);
      out += paint.yellow(chars.slice(i, j).join(""));
      i = j;
    } else if (c === "[" || c === "]" || c === "/") {
      out += paint.dim(c);
      i++;
    } else if (c === "-") {
      const j = until((x) => x === " " || x === "]" || x === ",");
      out += paint.green(chars.slice(i, j).join(""));
      i = j;
    } else if (c === " " || c === ",") {
      out += c;
      i++;
    } else {
      const j = until((x) => " []</,".includes(x));
      out += paint.cyan(chars.slice(i, j).join(""));
      i = j;
    }
  }
  return out;
}

function inlineColumn(groups: ReadonlyArray<ReadonlyArray<Item>>): number {
  let column = 0;
  for (const items of groups) {
    for (const [usage] of items) {
      const n = width(usage);
      if (n <= MAX_INLINE_USAGE && n > column) column = n;
    }
  }
  return column;
}

// One aligned description column shared by every section: the
// description beside the usage (below it when the usage is wider), and
// the detail as dim wrapped lines at the same column.
function section(
  title: string,
  items: ReadonlyArray<Item>,
  column: number,
  columns: number,
  paint: Styles,
): string {
  const descColumn = INDENT + column + 2;
  let out = `${paint.bold(title)}\n`;
  for (const [usage, desc, detail] of items) {
    const usageWidth = width(usage);
    out +=
      usageWidth <= column
        ? `${pad(INDENT)}${colorUsage(usage, paint)}${pad(column - usageWidth + 2)}${desc}\n`
        : `${pad(INDENT)}${colorUsage(usage, paint)}\n${pad(descColumn)}${desc}\n`;
    if (detail !== "") {
      for (const line of wrapText(detail, columns - descColumn)) {
        out += `${pad(descColumn)}${paint.dim(line)}\n`;
      }
    }
  }
  return out;
}

export type HelpLook = {
  readonly names: Names;
  // The build that isn't prod (dev, a test flavor), which the
  // title names.
  readonly unshipped: string | null;
  readonly color: boolean;
  // The terminal's width, clamped.
  readonly columns: number;
};

// The help pages, bound to this binary's names and terminal.
export const helpPages = (look: HelpLook) => {
  const bin = look.names.binaryName;
  const paint = styles(look.color);
  const items = catalog(look.names);
  const namespaces = namespacesOf(bin, items);
  const groups: ReadonlyArray<readonly [string, ReadonlyArray<Item>]> = [
    ["General", items.general],
    ["Worktrees", items.worktrees],
    ["Projects", items.projects],
    ["Config", items.config],
    ["Agents", items.agents],
    ["Shell integration", items.shell],
    ...byPlatform({ darwin: [], linux: [["Service", items.service] as const] }),
    ["Flags", items.flags],
    ["Environment", items.environment],
  ];
  const usageLine = (usage: string) =>
    `${paint.bold("Usage:")} ${bin} ${colorUsage(usage, paint)}`;

  // The base page: General's one-liners (`help <command>` has the
  // detail) plus one pointer line per namespace. `full` expands every
  // group in place.
  const page = (full: boolean): string => {
    const shown: ReadonlyArray<readonly [string, ReadonlyArray<Item>]> = full
      ? groups
      : [
          [
            "Commands",
            [
              ...items.general.map(([usage, desc]): Item => [usage, desc, ""]),
              ...namespaces.map(
                (ns): Item => [
                  `${ns.name} <command>`,
                  ns.desc,
                  `${ns.items.map(([usage]) => fieldsOf(usage)[1]).join(", ")}. Run \`${bin} ${ns.name}\` for details.`,
                ],
              ),
            ],
          ],
          ["Flags", items.flags],
          ["Environment", items.environment],
        ];
    const column = inlineColumn(shown.map(([, list]) => list));
    let out = `${paint.bold(`${bin}: Shigoto no Mori CLI`)}${look.unshipped === null ? "" : ` (${look.unshipped}: targets ~/${look.names.dataDir})`}\n\n`;
    out += `${usageLine("[--json] [--verbose] <command> [args]")}\n\n`;
    out += wrapText(
      `Commands target the worktree containing the current directory. From elsewhere, address worktrees as <name>, <project>/<name>, or a path, or pass -p <project>. The reserved names root and primary address a project's primary checkout (\`${bin} cd root\`). Omitting the name in the primary checkout opens a menu. Aliases: c cd, o open, new/n create, w worktrees, p projects.`,
      look.columns,
    ).join("\n");
    out += "\n\n";
    for (const [title, list] of shown) {
      out += `${section(title, list, column, look.columns, paint)}\n`;
    }
    out += wrapText(
      "Exit codes: 0 ok, 1 error, 2 usage, 3 worktree created but a lifecycle script failed (create prints the path either way), or sent or brought with something after it not holding.",
      look.columns,
    ).join("\n");
    return out;
  };

  // A namespace's own page, behind bare `sm worktrees` and the like.
  const namespacePage = (ns: (typeof namespaces)[number]): string => {
    let title = paint.bold(`${bin} ${ns.name}`);
    if (ns.shortAlias !== "")
      title += ` ${paint.dim(`(${ns.shortAlias} for short)`)}`;
    let out = `${title}\n\n${usageLine(`${ns.name} <command> [args]`)}\n\n`;
    out += `${wrapText(ns.blurb, look.columns).join("\n")}\n\n`;
    out += section(
      "Commands",
      ns.items,
      inlineColumn([ns.items]),
      look.columns,
      paint,
    );
    return out.trimEnd();
  };

  // One command's usage lines from the catalog, at full width: `sm
  // projects add --help` narrows to the subcommand, and an unknown
  // command gets the base page.
  const commandPage = (
    command: string,
    args: ReadonlyArray<string>,
  ): string => {
    let name = commandName(command);
    // shelve and unshelve share one usage line, keyed on shelve.
    if (name === "unshelve") name = "shelve";
    // `wt rm --help` documents rm itself.
    const [first, ...rest] = args;
    if (name === "worktrees" && first !== undefined && !first.startsWith("-")) {
      if (commandName(first) !== "worktrees") return commandPage(first, rest);
    }
    let sub = "";
    const ns = namespaces.find((each) => each.name === name);
    if (ns !== undefined) {
      if (first === undefined) return namespacePage(ns);
      const wanted = ns.canon(first);
      if (ns.items.some(([usage]) => fieldsOf(usage)[1] === wanted))
        sub = wanted;
    }
    const found: string[] = [];
    for (const [, list] of groups) {
      for (const [usage, desc, detail] of list) {
        let fields = fieldsOf(usage);
        // A bare worktree command matches its namespaced entry too.
        if (fields[0] === "worktrees" && fields[1] === name)
          fields = fields.slice(1);
        if (fields[0] !== name) continue;
        if (sub !== "" && fields[1] !== sub) continue;
        let entry = `${usageLine(usage)}\n  ${desc}\n`;
        if (detail !== "") {
          for (const line of wrapText(detail, look.columns - 2)) {
            entry += `  ${paint.dim(line)}\n`;
          }
        }
        found.push(entry);
      }
    }
    if (found.length === 0) return page(false);
    return `${found.join("\n")}\n${paint.dim(`Run \`${bin} --help\` for the full list.`)}`;
  };

  // The usage line of the command at `path` (its names after the
  // binary's), for a usage error.
  const usageOf = (path: ReadonlyArray<string>): string | undefined => {
    const [command, sub] = path;
    if (command === undefined) return undefined;
    for (const [, list] of groups) {
      for (const [usage] of list) {
        let fields = fieldsOf(usage);
        if (fields[0] === "worktrees" && fields[1] === command)
          fields = fields.slice(1);
        if (fields[0] === command && (sub === undefined || fields[1] === sub)) {
          return `Usage: ${bin} ${usage}`;
        }
      }
    }
    return undefined;
  };

  // What a command line asks of the help: the help before the command,
  // bare `sm` or `help [<command>]`, or a command with -h or --help
  // before any `--`. Undefined when it asks none. Bare `sm` is a usage
  // error, and exits 2.
  const asked = (
    args: ReadonlyArray<string>,
  ): { readonly text: string; readonly code: number } | undefined => {
    let leading = 0;
    while (args[leading] === "--help" || args[leading] === "-h") leading++;
    const rest = args.slice(leading);
    const [command, ...after] = rest;
    if (leading > 0 || command === undefined || command === "help") {
      const scan = command === "help" ? after : rest;
      const full = scan.some((arg) => arg === "--all" || arg === "-a");
      const [topic, ...more] = scan.filter(
        (arg) => arg !== "--all" && arg !== "-a",
      );
      return {
        text: topic === undefined ? page(full) : commandPage(topic, more),
        code: leading > 0 || rest.length > 0 ? 0 : 2,
      };
    }
    const { own } = splitAtDashes(after);
    if (own.includes("-h") || own.includes("--help")) {
      return { text: commandPage(command, after), code: 0 };
    }
    // A bare namespace is its page.
    const ns = namespaces.find((each) => each.name === commandName(command));
    if (ns !== undefined && after.length === 0) {
      return { text: namespacePage(ns), code: 0 };
    }
    return undefined;
  };

  return { asked, usageOf };
};
