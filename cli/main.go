package main

// sgm -- the Shigoto no Mori CLI, a Go port of the app's worktree
// engine (main/lib/) with the same on-disk state, ids, lock protocol,
// and JSON output shapes. The state root follows the compiled-in
// flavor (sgm -> ~/shigomori, sgm-d -> ~/shigomori-dev, see flavor.go);
// SHIGOMORI_ROOT overrides it (tests, sandboxes).
//
// Known deltas vs the app: project-usage stats aren't bumped,
// .worktreeinclude reconciliation doesn't rewrite project.json, the
// `port` field isn't populated, and `rm` can't reap scripts the app
// spawned into the worktree -- that registry lives in the app's
// process, so stop those from the app (or quit it) before removing
// their worktree from the CLI.

import (
	"fmt"
	"os"
)

func helpText() string {
	devNote := ""
	if flavor != "prod" {
		devNote = " (dev: targets ~/shigomori-dev)"
	}
	return binaryName + " -- Shigoto no Mori CLI" + devNote + `

Usage: ` + binaryName + ` [--json] [--verbose] <command> [args]

Commands run against the worktree/project containing the current
directory when possible; from anywhere else, address worktrees as
<name> or <project>/<name>.

Commands:
  list [-p <project>] [--all]     List worktrees (all projects when outside one)
  path [<name>] [-p <project>]    Print a worktree's directory
  create [<name>] [-p <project>] [-b <branch>] [--base <ref>]
                                  Create a worktree: carry-over, setup, port
  rm [<name>] [-f] [--keep-branch]
                                  Remove a worktree: teardown, release port,
                                  delete branch per app settings
  done [<name>] [-f]              Post-merge cleanup: land the checkout back
                                  on the primary branch, delete the merged
                                  one (refuses unmerged branches without -f)
  merge [<name>] [-m <method>]    Merge the worktree's PR via gh, method per
                                  the repo's settings (or --method override)
  adopt [<name>] [-f]             Convert an external worktree to managed:
                                  move it into the layout, run the lifecycle
                                  (refuses dirty worktrees without -f)
  setup [<name>] [-p <project>]   Re-run the setup script (and port-pool
                                  provision) on an existing worktree
  shelve / unshelve [<name>]      Toggle the app's "out of focus" flag
  project list                    List registered projects
  project add [<path>]            Register the repo containing <path> (default .)
  config [-p <project>] [--setup <cmd>] [--teardown <cmd>] [--default-branch <ref>]
                                  Show or set per-project config; "" clears
                                  a script (default-branch can't be cleared)

Flags:
  --json      Machine-readable output (NDJSON progress for create)
  --verbose   Diagnostics on stderr
  -h, --help  Show this help

Environment:
  SHIGOMORI_ROOT  Override the state root directory entirely

Exit codes: 0 ok; 1 error; 2 usage; 3 worktree created but a lifecycle
script failed (create prints the path either way).`
}

func main() {
	os.Exit(run())
}

func run() int {
	var (
		rest     []string
		showHelp bool
		showVer  bool
	)
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--json":
			jsonMode = true
		case "--verbose":
			verboseMode = true
		case "--help", "-h":
			showHelp = true
		case "--version", "-V":
			showVer = true
		default:
			rest = append(rest, arg)
		}
	}

	if showVer {
		out(version)
		return 0
	}
	if showHelp || len(rest) == 0 || rest[0] == "help" {
		out(helpText())
		if showHelp || len(rest) > 0 {
			return 0
		}
		return 2
	}

	initRoot()
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	ctx := resolveContext(cwd)

	command, args := rest[0], rest[1:]
	var code int
	switch command {
	case "list", "ls":
		code, err = cmdList(ctx, args)
	case "path":
		code, err = cmdPath(ctx, args)
	case "create":
		code, err = cmdCreate(ctx, args)
	case "rm", "remove":
		code, err = cmdRm(ctx, args)
	case "done":
		code, err = cmdDone(ctx, args)
	case "merge":
		code, err = cmdMerge(ctx, args)
	case "adopt":
		code, err = cmdAdopt(ctx, args)
	case "setup":
		code, err = cmdSetup(ctx, args)
	case "shelve":
		code, err = cmdShelve(ctx, args, true)
	case "unshelve":
		code, err = cmdShelve(ctx, args, false)
	case "project":
		code, err = cmdProject(ctx, args)
	case "config":
		code, err = cmdConfig(ctx, args)
	default:
		code, err = 2, usageErrf("Unknown command %q. Run `%s --help`.", command, binaryName)
	}
	if err != nil {
		if jsonMode {
			emit(map[string]any{"ok": false, "error": err.Error()})
		} else {
			fmt.Fprintf(os.Stderr, "%s: %s\n", binaryName, err.Error())
		}
	}
	return code
}
