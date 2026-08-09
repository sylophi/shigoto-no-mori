package main

// sgm -- the Shigoto no Mori CLI, a Go port of the app's worktree
// engine (main/lib/) with the same on-disk state, ids, lock protocol,
// and JSON output shapes. The state root follows the compiled-in
// flavor (sgm -> ~/shigomori, sgmd -> ~/shigomori-dev, see flavor.go);
// SHIGOMORI_ROOT overrides it (tests, sandboxes).
//
// Known deltas vs the app: project-usage stats aren't bumped,
// .worktreeinclude reconciliation doesn't rewrite project.json, the
// `port` field isn't populated, and `rm` / `project remove` can't reap
// scripts the app spawned into a worktree -- that registry lives in
// the app's process, so stop those from the app (or quit it) first.

import (
	"fmt"
	"os"
	"strings"
)

// Help is data; layout and color are computed. Commands are grouped by
// what they act on; every worktree command also takes -p <project>,
// noted once in the prose instead of on every usage line.
type helpItem struct{ usage, desc string }

type helpGroup struct {
	title string
	items []helpItem
}

var helpGroups = []helpGroup{
	{"Navigate", []helpItem{
		{"list [--all]", "List worktrees (all projects when outside one)"},
		{"path [<name>]", "Print a worktree's directory"},
		{"cd [<name>]",
			"Open a subshell inside a worktree, exit it to return (no name picks from a menu)"},
		{"app", "Open the Shigoto no Mori app"},
		{"config", "Open the global config file (config.json in the state root)"},
	}},
	{"Worktree", []helpItem{
		{"create [<name>] [-b <branch-name>] [--base <ref>]",
			"Create a worktree on a new branch named -b (default: the worktree name), forked from --base (default: the default branch), then carry-over, setup, port"},
		{"rm [<name>] [-f] [--keep-branch]",
			"Remove a worktree: teardown, release port, delete branch per app settings"},
		{"done [<name>] [-f]",
			"Post-merge cleanup: land the checkout back on the primary branch, delete the merged one (refuses unmerged branches without -f)"},
		{"merge [<name>] [-m <method>]",
			"Merge the worktree's PR via gh, method per the repo's settings (or --method override)"},
		{"adopt [<name-or-path>] [-f]",
			"Convert an external worktree to managed: move it into the layout, run the lifecycle (refuses dirty worktrees without -f)"},
		{"setup [<name>]",
			"Re-run the setup script (and port-pool provision) on an existing worktree"},
		{"shelve / unshelve [<name>]", `Toggle the app's "out of focus" flag`},
		{"open [<tool>] [<name>]",
			"Launch a launcher-row tool (Finder, editor, custom command) in a worktree, bare open shows the row as a menu"},
	}},
	{"Projects", []helpItem{
		{"projects list", "List registered projects"},
		{"projects add [<path>] [--all]",
			"Register the repo at <path> (default .) or with --all every repo found beneath it (asks first, --yes skips)"},
		{"projects remove [<name>]",
			"Unregister a project, worktrees stay on disk (asks first, no name picks from a menu)"},
		{"projects config [--setup <cmd>] [--teardown <cmd>] [--default-branch <ref>]",
			`Show or set per-project config ("" clears a script, default-branch can't be cleared)`},
	}},
	{"Flags", []helpItem{
		{"--json", "Machine-readable output (NDJSON progress for create)"},
		{"--verbose", "Diagnostics on stderr"},
		{"-h, --help", "Show this help"},
	}},
	{"Environment", []helpItem{
		{"SHIGOMORI_ROOT", "Override the state root directory entirely"},
	}},
}

func helpText() string {
	devNote := ""
	if flavor != "prod" {
		devNote = " (dev: targets ~/shigomori-dev)"
	}
	width := helpWidth()
	var b strings.Builder
	b.WriteString(boldOut(binaryName+" -- Shigoto no Mori CLI") + devNote + "\n\n")
	b.WriteString(boldOut("Usage:") + " " + binaryName + " " +
		colorUsage("[--json] [--verbose] <command> [args]") + "\n\n")
	for _, line := range wrapText(
		"Commands run against the worktree/project containing the current "+
			"directory when possible. From anywhere else, address worktrees as "+
			"<name>, <project>/<name>, or a directory path, or pass -p "+
			"<project>. From the primary checkout, omitting the name picks a "+
			"worktree from a menu. Aliases: l list, c cd, o open, p projects, "+
			"new create.", width) {
		b.WriteString(line + "\n")
	}
	b.WriteString("\n")

	col := 0
	for _, group := range helpGroups {
		for _, item := range group.items {
			if n := len([]rune(item.usage)); n <= maxInlineUsage && n > col {
				col = n
			}
		}
	}
	for _, group := range helpGroups {
		b.WriteString(renderHelpSection(group.title, group.items, col, width))
		b.WriteString("\n")
	}
	for _, line := range wrapText(
		"Exit codes: 0 ok, 1 error, 2 usage, 3 worktree created but a "+
			"lifecycle script failed (create prints the path either way).", width) {
		b.WriteString(line + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

const (
	helpIndent     = 2
	maxInlineUsage = 34
)

// The terminal's real width, clamped: hard wrapping below 60 helps
// nobody, and lines past ~110 columns get hard to scan.
func helpWidth() int {
	width := terminalWidth()
	if width == 0 {
		width = 80
	}
	if width < 60 {
		width = 60
	}
	if width > 110 {
		width = 110
	}
	return width
}

// One aligned description column shared by all sections. A usage wider
// than the column gets its own line with the description below, still
// at the column; descriptions word-wrap there. Color is applied after
// all width math, so alignment never depends on it.
func renderHelpSection(title string, items []helpItem, col, width int) string {
	descCol := helpIndent + col + 2
	var b strings.Builder
	b.WriteString(boldOut(title) + "\n")
	pad := func(n int) string { return strings.Repeat(" ", n) }
	for _, item := range items {
		usageWidth := len([]rune(item.usage))
		lines := wrapText(item.desc, width-descCol)
		if usageWidth <= col {
			b.WriteString(pad(helpIndent) + colorUsage(item.usage) + pad(col-usageWidth+2) + lines[0] + "\n")
			lines = lines[1:]
		} else {
			b.WriteString(pad(helpIndent) + colorUsage(item.usage) + "\n")
		}
		for _, line := range lines {
			b.WriteString(pad(descCol) + line + "\n")
		}
	}
	return b.String()
}

// Token-type coloring for usage strings: bare words (the command
// itself and its subcommands) cyan, <placeholders> yellow, flags
// green, brackets and separators dim. Runs before nothing -- width
// math strips ANSI, so this is purely cosmetic.
func colorUsage(usage string) string {
	var b strings.Builder
	runes := []rune(usage)
	for i := 0; i < len(runes); {
		r := runes[i]
		switch {
		case r == '<':
			j := i
			for j < len(runes) && runes[j] != '>' {
				j++
			}
			if j < len(runes) {
				j++
			}
			b.WriteString(yellowOut(string(runes[i:j])))
			i = j
		case r == '[' || r == ']' || r == '/':
			b.WriteString(dimOut(string(r)))
			i++
		case r == '-':
			j := i
			for j < len(runes) && runes[j] != ' ' && runes[j] != ']' && runes[j] != ',' {
				j++
			}
			b.WriteString(greenOut(string(runes[i:j])))
			i = j
		case r == ' ' || r == ',':
			b.WriteRune(r)
			i++
		default:
			j := i
			for j < len(runes) && runes[j] != ' ' && runes[j] != '[' && runes[j] != ']' && runes[j] != '<' && runes[j] != '/' && runes[j] != ',' {
				j++
			}
			b.WriteString(cyanOut(string(runes[i:j])))
			i = j
		}
	}
	return b.String()
}

var aliasCanonical = map[string]string{
	"ls": "list", "l": "list", "c": "cd", "o": "open",
	"p": "projects", "project": "projects", "new": "create",
	"remove": "rm", "unshelve": "shelve",
}

// Per-command help: the matching usage lines from the catalog, full
// width. `sgm projects add --help` narrows to the subcommand; an
// unknown command falls back to the full help.
func commandHelp(command string, args []string) string {
	name := command
	if canonical, ok := aliasCanonical[name]; ok {
		name = canonical
	}
	sub := ""
	if name == "projects" && len(args) > 0 {
		switch args[0] {
		case "list", "ls":
			sub = "list"
		case "add":
			sub = "add"
		case "remove", "rm":
			sub = "remove"
		case "config":
			sub = "config"
		}
	}
	width := helpWidth()
	var b strings.Builder
	found := false
	for _, group := range helpGroups {
		for _, item := range group.items {
			fields := strings.Fields(item.usage)
			if len(fields) == 0 || fields[0] != name {
				continue
			}
			if sub != "" && (len(fields) < 2 || fields[1] != sub) {
				continue
			}
			if found {
				b.WriteString("\n")
			}
			found = true
			b.WriteString(boldOut("Usage:") + " " + binaryName + " " + colorUsage(item.usage) + "\n")
			for _, line := range wrapText(item.desc, width-2) {
				b.WriteString("  " + line + "\n")
			}
		}
	}
	if !found {
		return helpText()
	}
	b.WriteString("\n" + dimOut("Run `"+binaryName+" --help` for the full list."))
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
		switch {
		case arg == "--json":
			jsonMode = true
		case arg == "--verbose":
			verboseMode = true
		// Before the command it's the global help; after, it belongs to
		// the command (`sgm rm --help` documents rm alone).
		case (arg == "--help" || arg == "-h") && len(rest) == 0:
			showHelp = true
		case arg == "--version" || arg == "-V":
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

	command, args := rest[0], rest[1:]
	for _, arg := range args {
		if arg == "-h" || arg == "--help" {
			out(commandHelp(command, args))
			return 0
		}
	}

	initRoot()
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	ctx := resolveContext(cwd)
	var code int
	switch command {
	case "list", "ls", "l":
		code, err = cmdList(ctx, args)
	case "path":
		code, err = cmdPath(ctx, args)
	case "cd", "c":
		code, err = cmdCd(ctx, args)
	case "open", "o":
		code, err = cmdOpen(ctx, args)
	case "app":
		code, err = cmdApp(ctx, args)
	case "create", "new":
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
	case "projects", "project", "p":
		code, err = cmdProject(ctx, args)
	case "config":
		code, err = cmdConfigOpen(ctx, args)
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
