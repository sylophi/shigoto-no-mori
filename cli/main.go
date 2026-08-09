package main

// sgm -- the Shigoto no Mori CLI, a Go port of the app's worktree
// engine (main/lib/) with the same on-disk state, ids, lock protocol,
// and JSON output shapes. The state root follows the compiled-in
// flavor (sgm -> ~/shigomori, sgmd -> ~/shigomori-dev, see flavor.go);
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
	"strings"
)

// Help is data; layout and color are computed. Every worktree command
// also takes -p <project>, noted once in the prose instead of on every
// usage line.
type helpItem struct{ usage, desc string }

var helpCommands = []helpItem{
	{"list [--all]", "List worktrees (all projects when outside one)"},
	{"path [<name>]", "Print a worktree's directory"},
	{"create [<name>] [-b <branch>] [--base <ref>]",
		"Create a worktree: carry-over, setup, port"},
	{"rm [<name>] [-f] [--keep-branch]",
		"Remove a worktree: teardown, release port, delete branch per app settings"},
	{"done [<name>] [-f]",
		"Post-merge cleanup: land the checkout back on the primary branch, delete the merged one (refuses unmerged branches without -f)"},
	{"merge [<name>] [-m <method>]",
		"Merge the worktree's PR via gh, method per the repo's settings (or --method override)"},
	{"adopt [<name>] [-f]",
		"Convert an external worktree to managed: move it into the layout, run the lifecycle (refuses dirty worktrees without -f)"},
	{"setup [<name>]",
		"Re-run the setup script (and port-pool provision) on an existing worktree"},
	{"shelve / unshelve [<name>]", `Toggle the app's "out of focus" flag`},
	{"project list", "List registered projects"},
	{"project add [<path>] [--all]",
		"Register the repo at <path> (default .) or with --all every repo found beneath it (asks first, --yes skips)"},
	{"config [--setup <cmd>] [--teardown <cmd>] [--default-branch <ref>]",
		`Show or set per-project config; "" clears a script (default-branch can't be cleared)`},
}

var helpFlags = []helpItem{
	{"--json", "Machine-readable output (NDJSON progress for create)"},
	{"--verbose", "Diagnostics on stderr"},
	{"-h, --help", "Show this help"},
}

var helpEnv = []helpItem{
	{"SHIGOMORI_ROOT", "Override the state root directory entirely"},
}

func helpText() string {
	devNote := ""
	if flavor != "prod" {
		devNote = " (dev: targets ~/shigomori-dev)"
	}
	return binaryName + " -- Shigoto no Mori CLI" + devNote + "\n\n" +
		boldOut("Usage:") + " " + binaryName + " [--json] [--verbose] <command> [args]\n\n" +
		"Commands run against the worktree/project containing the current\n" +
		"directory when possible; from anywhere else, address worktrees as\n" +
		"<name> or <project>/<name>, or pass -p <project>. From the primary\n" +
		"checkout, omitting the name picks a worktree interactively.\n\n" +
		renderHelpSection("Commands", helpCommands) + "\n" +
		renderHelpSection("Flags", helpFlags) + "\n" +
		renderHelpSection("Environment", helpEnv) + "\n" +
		"Exit codes: 0 ok; 1 error; 2 usage; 3 worktree created but a lifecycle\n" +
		"script failed (create prints the path either way)."
}

// One aligned description column per section. A usage wider than the
// column gets its own line with the description below, still at the
// column; descriptions word-wrap there. Color is applied after all
// width math, so alignment never depends on it.
func renderHelpSection(title string, items []helpItem) string {
	const indent = 2
	const maxInlineUsage = 30
	const totalWidth = 78

	col := 0
	for _, item := range items {
		if n := len([]rune(item.usage)); n <= maxInlineUsage && n > col {
			col = n
		}
	}
	descCol := indent + col + 2

	var b strings.Builder
	b.WriteString(boldOut(title+":") + "\n")
	pad := func(n int) string { return strings.Repeat(" ", n) }
	for _, item := range items {
		usageWidth := len([]rune(item.usage))
		lines := wrapText(item.desc, totalWidth-descCol)
		if usageWidth <= col {
			b.WriteString(pad(indent) + cyanOut(item.usage) + pad(col-usageWidth+2) + lines[0] + "\n")
			lines = lines[1:]
		} else {
			b.WriteString(pad(indent) + cyanOut(item.usage) + "\n")
		}
		for _, line := range lines {
			b.WriteString(pad(descCol) + line + "\n")
		}
	}
	return b.String()
}

func wrapText(text string, width int) []string {
	if width < 20 {
		width = 20
	}
	words := strings.Fields(text)
	var lines []string
	line := ""
	for _, word := range words {
		if line != "" && len([]rune(line))+1+len([]rune(word)) > width {
			lines = append(lines, line)
			line = word
			continue
		}
		if line == "" {
			line = word
		} else {
			line += " " + word
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		lines = []string{""}
	}
	return lines
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

	initColor()

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
			fmt.Fprintf(os.Stderr, "%s %s\n", redErr(binaryName+":"), err.Error())
		}
	}
	return code
}
