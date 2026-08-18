package main

// sm -- the Shigoto no Mori CLI, a Go port of the app's worktree
// engine (main/lib/) with the same on-disk state, ids, lock protocol,
// and JSON output shapes. The state root follows the compiled-in
// flavor (sm -> ~/shigomori, smd -> ~/shigomori-dev, see flavor.go);
// a ~/.config/<flavor-name>/root pointer file relocates it (state.go),
// and SHIGOMORI_ROOT overrides both (tests, sandboxes).
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
// noted once in the prose instead of on every usage line. desc is the
// concise one-liner beside the usage; detail is the dim elaboration
// below it.
type helpItem struct{ usage, desc, detail string }

type helpGroup struct {
	title string
	items []helpItem
}

var generalItems = []helpItem{
	{"cd [<name>]", "Open a subshell in any worktree",
		"Picks a project, then a worktree. Exit the shell to return. With shell integration (see `shell`), your current shell cd's instead."},
	{"run [<script>] [<args>...]", "Run a package.json script here",
		"Works inside any registered project's checkout or worktree. Detects the package manager from the lockfile (bun/pnpm/yarn/npm) and execs `<manager> run <script>` at the worktree root, so output, signals, and the exit code are the script's own. Extra args pass through to the script (put dashed ones after --). With no script, lists them."},
	{"app", "Open the Shigoto no Mori app", ""},
	{"update [--check]", "Update the app to the latest release",
		"Checks GitHub releases, downloads, verifies, and installs -- all from the CLI, without opening the app (the linked CLI updates with it). If the app is running it restarts into the new version. --check only asks the feed and reports."},
	{"help [<command>] [--all]", "Show help",
		"help <command> documents one command, --all prints every command at once."},
}

var worktreeItems = []helpItem{
	{"worktrees list [--all]", "List worktrees",
		"All projects when outside one, or with --all."},
	{"worktrees switch [<name>]", "Open a subshell in this project's worktrees",
		"Like cd without the project menu. Exit the shell to return, or cd in place with shell integration."},
	{"worktrees path [<name>]", "Print a worktree's directory", ""},
	{"worktrees create [<name>] [-b <branch-name>] [--base <ref>] [--no-cd]", "Create a worktree",
		"On a new branch named -b (default: the worktree name), forked from --base (default: the default branch). Runs carry-over, the setup script, and port provision, then drops into the new worktree -- a subshell, or your own shell with shell integration (--no-cd, --json, and scripts skip it)."},
	{"worktrees rm [<name>] [-f] [--keep-branch]", "Remove a worktree",
		"Teardown, release port, delete the branch per app settings."},
	{"worktrees done [<name>] [-f]", "Post-merge cleanup",
		"Lands the checkout back on the primary branch and deletes the merged one. Refuses unmerged branches without -f."},
	{"worktrees pr [<name>]", "Open the worktree's PR in the browser",
		"The PR for the worktree's branch, any state. Errors when the branch has none."},
	{"worktrees merge [<name>] [-m <method>]", "Merge the worktree's PR via gh",
		"Method follows the repo's settings unless -m overrides."},
	{"worktrees land [<name>] [-m <method>] [-f] [--keep-branch]", "Merge the PR, then clean up",
		"merge + rm in one step (done when landing the primary checkout), fast-forwarding the primary branch in between. An already-merged PR skips straight to cleanup."},
	{"worktrees adopt [<name-or-path>] [-f]", "Convert an external worktree to managed",
		"Moves it into the layout and runs the lifecycle. Refuses dirty worktrees without -f."},
	{"worktrees setup [<name>]", "Re-run the setup script",
		"Also re-provisions the port-pool port."},
	{"worktrees shelve / unshelve [<name>]", `Toggle the app's "out of focus" flag`, ""},
	{"worktrees open [<tool>] [<name>]", "Launch a launcher-row tool in a worktree",
		"Finder, editors, custom commands. With no tool, shows the row as a menu."},
}

var projectItems = []helpItem{
	{"projects list", "List registered projects", ""},
	{"projects add [<path>] [--all]", "Register a repo",
		"The repo at <path> (default .). --all registers every repo beneath it after confirmation (--yes skips)."},
	{"projects remove [<name-or-path>]", "Unregister a project",
		"Worktrees stay on disk. Prompts for confirmation (--yes skips). " +
			"When two projects share a name, remove by path (which also " +
			"reaches an entry whose repo has since moved away)."},
	{"projects config [<command>] [args]",
		"Show or set per-project config",
		"Bare: prints project.json. The global config's verbs work here too, scoped by -p: " +
			"list, get <key>, set <key> <value>, unset <key>, edit. Keys: `" + binaryName +
			" projects config list`. Structured lists get element verbs: launcher add " +
			"<label> <command> / rm <label-or-id>, and carryover add <path> [--copy|--symlink] " +
			"/ rm <path> (add upserts, so re-adding switches the mode). The flags --setup <cmd>, " +
			`--teardown <cmd>, and --default-branch <ref> remain as shorthands: "" clears a ` +
			"script, and default-branch can't be cleared."},
}

var configItems = []helpItem{
	{"config list", "Show every setting",
		"Effective values, with (default) marking keys not present in config.json."},
	{"config get <key>", "Print one setting's effective value", ""},
	{"config set <key> <value>", "Change a setting",
		"Booleans accept true/false, on/off, yes/no, 1/0. Setting a key to its default removes " +
			"it from the file, same as the app."},
	{"config unset <key>", "Reset a setting to its default", ""},
	{"config launcher [<command>]", "Manage global custom launchers",
		"add <label> <command> adds one, rm <label-or-id> removes one, bare lists them. " +
			"Per-project launchers: `" + binaryName + " projects config launcher`."},
	{"config edit", "Open config.json in your editor",
		"$VISUAL/$EDITOR in a terminal, the OS opener otherwise."},
}

var shellItems = []helpItem{
	{"shell install [<shell>]", "Hook shell integration into your shell config",
		"A guarded eval line in .zshrc/.bashrc (marker-fenced) or a fish conf.d drop-in. Defaults to your login shell."},
	{"shell uninstall", "Remove the hook from every shell's config",
		"Only removes hooks it recognizably wrote. Edited blocks are reported and left alone."},
	{"shell status", "Show hook and session state", ""},
	{"shell init <zsh|bash|fish>", "Print the wrapper the hook evals",
		"A function shadowing the command: it runs the real binary, then cd's to the path the binary reports."},
}

var flagItems = []helpItem{
	{"--json", "Machine-readable output", "NDJSON progress for create."},
	{"--verbose", "Diagnostics on stderr", ""},
	{"-h, --help", "Show this help", "After a command, documents that command."},
}

var envItems = []helpItem{
	{"SHIGOMORI_ROOT", "Override the state root directory entirely",
		"Without it, the root comes from ~/.config/" + rootDirName + "/root when that file exists (one line holding an absolute path, honoring $XDG_CONFIG_HOME), else ~/" + rootDirName + "."},
}

// One row per namespace: the items its subcommands resolve against,
// the bare-page renderer, and the namespace-local alias fold (nil =
// none). commandHelp derives both the bare page and per-subcommand
// addressability from this, so a new namespace is a one-row change.
var helpNamespaces = []struct {
	name  string
	items []helpItem
	page  func() string
	canon func(string) string
}{
	{"worktrees", worktreeItems, worktreesHelpText, nil},
	{"projects", projectItems, projectsHelpText, canonicalProjectsSub},
	{"config", configItems, configHelpText, nil},
	{"shell", shellItems, shellHelpText, nil},
}

// The full catalog, used by per-command help matching. The base help
// page renders only General plus one pointer line per namespace; bare
// `sm worktrees` / `sm projects` print their namespace's page.
var helpGroups = []helpGroup{
	{"General", generalItems},
	{"Worktrees", worktreeItems},
	{"Projects", projectItems},
	{"Config", configItems},
	{"Shell integration", shellItems},
	{"Flags", flagItems},
	{"Environment", envItems},
}

// The comma-separated subcommand names for a namespace's pointer line
// on the base help page, derived from the catalog so the two can't
// drift. Field 1 of each usage is the subcommand; combined lines like
// "worktrees shelve / unshelve" collapse to their first name.
func subcommandList(items []helpItem) string {
	names := make([]string, len(items))
	for i, item := range items {
		names[i] = strings.Fields(item.usage)[1]
	}
	return strings.Join(names, ", ")
}

func inlineCol(groups []helpGroup) int {
	col := 0
	for _, group := range groups {
		for _, item := range group.items {
			if n := len([]rune(item.usage)); n <= maxInlineUsage && n > col {
				col = n
			}
		}
	}
	return col
}

// The base page: General plus one pointer line per namespace. --all
// expands every group in place.
func helpText(full bool) string {
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
		"Commands target the worktree containing the current directory. "+
			"From elsewhere, address worktrees as <name>, <project>/<name>, "+
			"or a path, or pass -p <project>. The reserved names root and "+
			"primary address a project's primary checkout (`"+binaryName+
			" cd root`). Omitting the name in the primary checkout opens a "+
			"menu. Aliases: c cd, o open, new/n create, w worktrees, "+
			"p projects.", width) {
		b.WriteString(line + "\n")
	}
	b.WriteString("\n")

	groups := helpGroups
	if !full {
		general := append(append([]helpItem{}, generalItems...),
			helpItem{"worktrees <command>", "Worktree commands",
				subcommandList(worktreeItems) + ". Run `" + binaryName + " worktrees` for details."},
			helpItem{"projects <command>", "Project commands",
				subcommandList(projectItems) + ". Run `" + binaryName + " projects` for details."},
			helpItem{"config <command>", "Global settings",
				subcommandList(configItems) + ". Run `" + binaryName + " config` for details."},
			helpItem{"shell <command>", "Shell integration: cd without subshells",
				subcommandList(shellItems) + ". Run `" + binaryName + " shell` for details."},
		)
		groups = []helpGroup{
			{"Commands", general},
			{"Flags", flagItems},
			{"Environment", envItems},
		}
	}
	col := inlineCol(groups)
	for _, group := range groups {
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

// The namespace pages behind bare `sm worktrees` / `sm projects` /
// `sm shell`. An empty shortAlias omits the tag.
func namespaceHelpText(name, shortAlias, blurb string, items []helpItem) string {
	width := helpWidth()
	var b strings.Builder
	title := boldOut(binaryName + " " + name)
	if shortAlias != "" {
		title += " " + dimOut("("+shortAlias+" for short)")
	}
	b.WriteString(title + "\n\n")
	b.WriteString(boldOut("Usage:") + " " + binaryName + " " +
		colorUsage(name+" <command> [args]") + "\n\n")
	for _, line := range wrapText(blurb, width) {
		b.WriteString(line + "\n")
	}
	b.WriteString("\n")
	col := inlineCol([]helpGroup{{"", items}})
	b.WriteString(renderHelpSection("Commands", items, col, width))
	return strings.TrimRight(b.String(), "\n")
}

func worktreesHelpText() string {
	return namespaceHelpText("worktrees", "w or wt",
		"The worktrees prefix is optional: "+binaryName+" rm == "+binaryName+
			" wt rm. All commands accept -p <project>.", worktreeItems)
}

func projectsHelpText() string {
	return namespaceHelpText("projects", "p",
		"Manage registered projects. A project is addressed by name, or "+
			"by its path when the name isn't unique.", projectItems)
}

func configHelpText() string {
	return namespaceHelpText("config", "",
		"Global settings, stored in config.json in the state root. Keys "+
			"and current values: `"+binaryName+" config list`. Per-project "+
			"settings live under `"+binaryName+" projects config`.", configItems)
}

func shellHelpText() string {
	return namespaceHelpText("shell", "",
		"Shell integration makes cd and create move your current shell "+
			"into the worktree instead of nesting a subshell. install "+
			"hooks it into your shell config. The hook evals `"+binaryName+
			" shell init <shell>`, whose wrapper function runs the real "+
			"binary and cd's to the path it reports. Without the hook, "+
			"those commands keep opening a subshell.", shellItems)
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

// One aligned description column shared by all sections: the concise
// desc sits beside the usage (below it when the usage is wider than
// the column), and the detail follows as dim wrapped lines at the same
// column. Color is applied after all width math, so alignment never
// depends on it.
func renderHelpSection(title string, items []helpItem, col, width int) string {
	descCol := helpIndent + col + 2
	var b strings.Builder
	b.WriteString(boldOut(title) + "\n")
	pad := func(n int) string { return strings.Repeat(" ", n) }
	for _, item := range items {
		usageWidth := len([]rune(item.usage))
		if usageWidth <= col {
			b.WriteString(pad(helpIndent) + colorUsage(item.usage) + pad(col-usageWidth+2) + item.desc + "\n")
		} else {
			b.WriteString(pad(helpIndent) + colorUsage(item.usage) + "\n")
			b.WriteString(pad(descCol) + item.desc + "\n")
		}
		if item.detail != "" {
			for _, line := range wrapText(item.detail, width-descCol) {
				b.WriteString(pad(descCol) + dimOut(line) + "\n")
			}
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

// The single command table: names, aliases, worktrees-namespace
// membership, and handlers in one place. Dispatch (run), the namespace
// dispatcher (cmdWorktrees), and per-command help all canonicalize
// through it, so adding or renaming a command is a one-row change.
type command struct {
	name    string
	aliases []string
	// Also reachable as `sm worktrees <name>`.
	worktree bool
	// Never looks at the cwd; run() skips the git context probes.
	noCwd bool
	run   func(cliContext, []string) (int, error)
}

var commands = []command{
	{name: "list", aliases: []string{"ls", "l"}, worktree: true, run: cmdList},
	{name: "path", worktree: true, run: cmdPath},
	{name: "cd", aliases: []string{"c"}, worktree: true, run: cmdCd},
	{name: "switch", worktree: true, run: cmdWorktree},
	{name: "open", aliases: []string{"o"}, worktree: true, run: cmdOpen},
	{name: "create", aliases: []string{"new", "n"}, worktree: true, run: cmdCreate},
	{name: "rm", aliases: []string{"remove"}, worktree: true, run: cmdRm},
	{name: "done", worktree: true, run: cmdDone},
	{name: "pr", worktree: true, run: cmdPr},
	{name: "merge", worktree: true, run: cmdMerge},
	{name: "land", worktree: true, run: cmdLand},
	{name: "adopt", worktree: true, run: cmdAdopt},
	{name: "setup", worktree: true, run: cmdSetup},
	{name: "shelve", worktree: true,
		run: func(ctx cliContext, args []string) (int, error) { return cmdShelve(ctx, args, true) }},
	{name: "unshelve", worktree: true,
		run: func(ctx cliContext, args []string) (int, error) { return cmdShelve(ctx, args, false) }},
	{name: "run", run: cmdRun},
	// Handler assigned in init(): cmdWorktrees dispatches back through
	// this table, and a direct reference here would be an
	// initialization cycle.
	{name: "worktrees", aliases: []string{"worktree", "wt", "w"}},
	{name: "projects", aliases: []string{"project", "p"}, run: cmdProject},
	{name: "app", noCwd: true, run: cmdApp},
	{name: "update", noCwd: true, run: cmdUpdate},
	{name: "config", noCwd: true, run: cmdConfigGlobal},
	{name: "shell", noCwd: true, run: cmdShell},
}

func init() {
	lookupCommand("worktrees").run = cmdWorktrees
}

func lookupCommand(name string) *command {
	for i := range commands {
		c := &commands[i]
		if c.name == name {
			return c
		}
		for _, alias := range c.aliases {
			if alias == name {
				return c
			}
		}
	}
	return nil
}

func canonicalCommandName(name string) string {
	if cmd := lookupCommand(name); cmd != nil {
		return cmd.name
	}
	return name
}

// The projects namespace's own alias fold, shared by its dispatcher
// and per-command help. Separate from the main table on purpose: `rm`
// here means `projects remove`, while the bare `rm` removes a worktree.
func canonicalProjectsSub(name string) string {
	switch name {
	case "ls":
		return "list"
	case "rm":
		return "remove"
	}
	return name
}

// Per-command help: the matching usage lines from the catalog, full
// width. `sm projects add --help` narrows to the subcommand; an
// unknown command falls back to the full help.
func commandHelp(command string, args []string) string {
	name := canonicalCommandName(command)
	// shelve and unshelve share one usage line, keyed on shelve.
	if name == "unshelve" {
		name = "shelve"
	}
	// `wt rm --help` documents rm itself; recurse through the namespace.
	if name == "worktrees" && len(args) > 0 {
		subName := canonicalCommandName(args[0])
		if subName != "worktrees" && !strings.HasPrefix(subName, "-") {
			return commandHelp(args[0], args[1:])
		}
	}
	sub := ""
	for _, ns := range helpNamespaces {
		if name != ns.name {
			continue
		}
		// Bare namespace help is the namespace page.
		if len(args) == 0 {
			return ns.page()
		}
		// Subcommands derive from the catalog, like subcommandList, so
		// a new one is help-addressable without touching this loop.
		cand := args[0]
		if ns.canon != nil {
			cand = ns.canon(cand)
		}
		for _, item := range ns.items {
			if strings.Fields(item.usage)[1] == cand {
				sub = cand
				break
			}
		}
		break
	}
	width := helpWidth()
	var b strings.Builder
	found := false
	for _, group := range helpGroups {
		for _, item := range group.items {
			fields := strings.Fields(item.usage)
			if len(fields) == 0 {
				continue
			}
			// Bare worktree commands match their namespaced entry too:
			// `sm rm --help` finds "worktrees rm ...".
			if fields[0] == "worktrees" && len(fields) > 1 && fields[1] == name {
				fields = fields[1:]
			}
			if fields[0] != name {
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
			b.WriteString("  " + item.desc + "\n")
			if item.detail != "" {
				for _, line := range wrapText(item.detail, width-2) {
					b.WriteString("  " + dimOut(line) + "\n")
				}
			}
		}
	}
	if !found {
		return helpText(false)
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
	cliArgs := os.Args[1:]
	for i := 0; i < len(cliArgs); i++ {
		arg := cliArgs[i]
		// `--` ends the global scan: everything after it belongs to the
		// command verbatim (`sm run test -- --json` must hand --json to
		// the test script, not flip jsonMode). The terminator itself is
		// kept for the command's own parser.
		if arg == "--" {
			rest = append(rest, cliArgs[i:]...)
			break
		}
		switch {
		case arg == "--json":
			jsonMode = true
		case arg == "--verbose":
			verboseMode = true
		// Before the command it's the global help; after, it belongs to
		// the command (`sm rm --help` documents rm alone).
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
		scanArgs := rest
		if len(rest) > 0 && rest[0] == "help" {
			scanArgs = rest[1:]
		}
		full := false
		var topic []string
		for _, arg := range scanArgs {
			if arg == "--all" || arg == "-a" {
				full = true
			} else {
				topic = append(topic, arg)
			}
		}
		switch {
		case len(topic) > 0:
			// `sm help rm`, `sm help worktrees create`, ...
			out(commandHelp(topic[0], topic[1:]))
		default:
			out(helpText(full))
		}
		if showHelp || len(rest) > 0 {
			return 0
		}
		return 2
	}

	command, args := rest[0], rest[1:]
	for _, arg := range args {
		// Past `--` a help flag is script cargo, not a help request.
		if arg == "--" {
			break
		}
		if arg == "-h" || arg == "--help" {
			out(commandHelp(command, args))
			return 0
		}
	}

	cmd := lookupCommand(command)
	if cmd == nil {
		err := usageErrf("Unknown command %q. Run `%s --help`.", command, binaryName)
		reportError(err)
		return 2
	}

	initRoot()
	ctx := cliContext{projects: loadProjects()}
	if !cmd.noCwd {
		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}
		ctx = resolveContext(cwd)
	}
	code, err := cmd.run(ctx, args)
	if err != nil {
		reportError(err)
	}
	return code
}

func reportError(err error) {
	if jsonMode {
		doc := map[string]any{"ok": false, "error": err.Error()}
		// Stable machine-readable code so the app maps failures (entity
		// gone, ...) without matching prose.
		if kind := errorKindOf(err); kind != "" {
			doc["code"] = kind
		}
		emit(doc)
	} else {
		fmt.Fprintf(os.Stderr, "%s %s\n", redErr(binaryName+":"), err.Error())
	}
}
