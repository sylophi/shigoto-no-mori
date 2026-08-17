package main

// sm shell <install|uninstall|status|init> -- shell integration, so cd
// and create move the calling shell instead of nesting a subshell (a
// child process can never chdir its parent, see cmd_cd.go).
//
// The pieces, zoxide-style:
//   - `shell init <shell>` prints a wrapper function that shadows the
//     sm command. The wrapper mints a temp "directive file", exports
//     its path as SHIGOMORI_CD_FILE, runs the real binary, then cd's to
//     whatever path the binary left in the file. The file carries a raw
//     path and is never parsed as shell, so nothing sm prints can
//     inject into the caller.
//   - `shell install` adds one guarded eval line to the shell's config
//     (a marker-fenced block in the rc file for zsh/bash, a conf.d
//     drop-in for fish). The guard (`command -v sm ...`) makes the line inert
//     when the binary is gone, so a trashed app never breaks shell
//     startup. The wrapper body itself always comes fresh from `shell
//     init`, never embedded in the rc, so upgrades need no re-install.
//   - `shell uninstall` removes exactly what install wrote, from every
//     supported shell. Blocks whose inner content isn't recognizably
//     ours are reported and left alone, mirroring cliInstall.ts's
//     foreign-link policy.
//
// Markers and the fish filename derive from rootDirName, so the prod
// and dev flavors can be installed side by side without collisions.

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Set by the wrapper for every invocation. Doubles as the "integration
// is active in this session" signal for `shell status`.
const cdFileEnv = "SHIGOMORI_CD_FILE"

// The wrapper's directive file for this invocation, "" without one.
// The single place cdFileEnv is read: the cd/create gates and
// enterWorktreeShell all answer "can the calling shell move?" here.
func cdDirectiveFile() string { return os.Getenv(cdFileEnv) }

// os.Environ() minus the directive file: children (lifecycle scripts,
// the fallback subshell) must never inherit the caller's cd handshake,
// or a nested `sm cd` inside a setup script could retarget the outer
// wrapper and move the user's shell somewhere they never asked for.
func envWithoutCdFile() []string {
	env := os.Environ()
	kept := env[:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, cdFileEnv+"=") {
			kept = append(kept, kv)
		}
	}
	return kept
}

var shellKinds = []string{"zsh", "bash", "fish"}

func cmdShell(_ cliContext, args []string) (int, error) {
	if len(args) == 0 {
		out(shellHelpText())
		return 0, nil
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "init":
		return cmdShellInit(rest)
	case "install":
		return cmdShellInstall(rest)
	case "uninstall":
		return cmdShellUninstall(rest)
	case "status":
		return cmdShellStatus(rest)
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s shell <install|uninstall|status|init>", sub, binaryName)
	}
}

// The user's login shell, as a supported kind or "".
func loginShellKind() string {
	kind := filepath.Base(os.Getenv("SHELL"))
	if slices.Contains(shellKinds, kind) {
		return kind
	}
	return ""
}

// --- the wrapper snippet (`shell init`) ---

// Helper-function name, flavored so prod and dev wrappers coexist:
// __shigomori_wrap / __shigomori_dev_wrap.
func wrapHelperName() string {
	return "__" + strings.ReplaceAll(rootDirName, "-", "_") + "_wrap"
}

func wrapperSnippet(kind string) (string, error) {
	switch kind {
	case "zsh", "bash":
		return posixWrapperSnippet(), nil
	case "fish":
		return fishWrapperSnippet(), nil
	default:
		return "", usageErrf("Unsupported shell %q. Usage: %s shell init <zsh|bash|fish>", kind, binaryName)
	}
}

// Comment atop both snippet dialects, explaining the directive-file
// protocol once.
func wrapperHeader(kindNote string) string {
	return fmt.Sprintf(`# Shigoto no Mori shell integration (%s shell init%s). The wrapper
# hands the real binary a directive file via %s. When a
# command wants this shell somewhere (cd, create), it writes the target
# path there and the wrapper cd's. The file carries a raw path, never
# shell code.
`, binaryName, kindNote, cdFileEnv)
}

func posixWrapperSnippet() string {
	helper := wrapHelperName()
	var b strings.Builder
	b.WriteString(wrapperHeader(""))
	b.WriteString(fmt.Sprintf(`%s() {
  local bin="$1" tmp rc dir
  shift
  tmp="$(command mktemp)" || { command "$bin" "$@"; return; }
  %s="$tmp" command "$bin" "$@"
  rc=$?
  if [ -s "$tmp" ]; then
    IFS= read -r dir <"$tmp"
    [ -d "$dir" ] && cd -- "$dir"
  fi
  command rm -f -- "$tmp"
  return "$rc"
}
`, helper, cdFileEnv))
	for _, name := range []string{binaryName, aliasName} {
		b.WriteString(fmt.Sprintf("%s() { %s %s \"$@\"; }\n", name, helper, name))
	}
	return b.String()
}

func fishWrapperSnippet() string {
	helper := wrapHelperName()
	var b strings.Builder
	b.WriteString(wrapperHeader(" fish"))
	b.WriteString(fmt.Sprintf(`function %s
    set -l bin $argv[1]
    set -e argv[1]
    set -l tmp (command mktemp)
    or begin
        command $bin $argv
        return $status
    end
    %s=$tmp command $bin $argv
    set -l rc $status
    if test -s $tmp
        set -l dir (command head -n 1 -- $tmp)
        if test -d "$dir"
            cd -- $dir
        end
    end
    command rm -f -- $tmp
    return $rc
end
`, helper, cdFileEnv))
	for _, name := range []string{binaryName, aliasName} {
		b.WriteString(fmt.Sprintf("function %s --wraps %s\n    %s %s $argv\nend\n", name, name, helper, name))
	}
	return b.String()
}

func cmdShellInit(args []string) (int, error) {
	if len(args) != 1 {
		return 2, usageErrf("Usage: %s shell init <zsh|bash|fish>", binaryName)
	}
	snippet, err := wrapperSnippet(args[0])
	if err != nil {
		return exitCodeOf(err), err
	}
	fmt.Fprint(os.Stdout, snippet)
	return 0, nil
}

// --- rc-file hook management (install / uninstall / status) ---

func hookBeginMarker() string { return "# >>> " + rootDirName + " shell integration >>>" }
func hookEndMarker() string   { return "# <<< " + rootDirName + " shell integration <<<" }

// The one guarded line between the markers. The guard keeps shell
// startup silent when the binary is gone (app trashed, link removed),
// which is what makes writing into a dotfile at all responsible.
func hookGuardLine(kind string) string {
	return fmt.Sprintf(
		`command -v %s >/dev/null 2>&1 && eval "$(command %s shell init %s)"`,
		binaryName, binaryName, kind)
}

func hookBlock(kind string) string {
	return hookBeginMarker() + "\n" + hookGuardLine(kind) + "\n" + hookEndMarker() + "\n"
}

// fish has no line to eval in an rc file. The drop-in is the whole
// hook, auto-loaded from conf.d and removed by deleting the file.
func fishHookContent() string {
	return fmt.Sprintf(`%s
# Managed by `+"`%s shell install`"+`. Edits here are overwritten.
if command -q %s
    command %s shell init fish | source
end
%s
`, hookBeginMarker(), binaryName, binaryName, binaryName, hookEndMarker())
}

func hookPath(kind string) string {
	home, _ := os.UserHomeDir()
	switch kind {
	case "zsh":
		dir := os.Getenv("ZDOTDIR")
		if dir == "" {
			dir = home
		}
		return filepath.Join(dir, ".zshrc")
	case "bash":
		// macOS terminals start bash as a *login* shell, which reads
		// .bash_profile/.bash_login/.profile and never .bashrc, so
		// target the first login file that exists (never creating one
		// that would shadow another).
		for _, name := range []string{".bash_profile", ".bash_login", ".profile"} {
			if candidate := filepath.Join(home, name); fileExists(candidate) {
				return candidate
			}
		}
		return filepath.Join(home, ".bash_profile")
	default: // fish
		// configHomeDir is "" only when the home dir is unresolvable,
		// in which case `home` above is too -- no fallback can help.
		return filepath.Join(configHomeDir(), "fish", "conf.d", rootDirName+".fish")
	}
}

// Everything install would need to know about one shell's hook:
//   installed  the hook is present and recognizably ours
//   missing    no hook (or no rc file at all)
//   modified   markers present but content we didn't write, never
//              touched by install/uninstall, reported instead
type hookState struct {
	Shell string `json:"shell"`
	Path  string `json:"path"`
	State string `json:"state"` // installed | missing | modified
}

// A line we're willing to delete: blank, a comment, or a line that
// references our own `shell init` (any guard-line vintage).
func hookLineOurs(line string) bool {
	trimmed := strings.TrimSpace(line)
	return trimmed == "" ||
		strings.HasPrefix(trimmed, "#") ||
		strings.Contains(trimmed, binaryName+" shell init")
}

// The fenced block's location in an rc file. ok is false when there is
// no complete block. broken marks a begin marker with no end (treated
// as modified: we won't guess where the user's file resumes).
type hookSpan struct {
	begin, end int // line indexes, inclusive of the markers
	ours       bool
}

func findHookSpan(lines []string) (span hookSpan, found, broken bool) {
	begin := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == hookBeginMarker() {
			begin = i
			break
		}
	}
	if begin < 0 {
		return hookSpan{}, false, false
	}
	for i := begin + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == hookEndMarker() {
			ours := true
			for _, inner := range lines[begin+1 : i] {
				if !hookLineOurs(inner) {
					ours = false
					break
				}
			}
			return hookSpan{begin: begin, end: i, ours: ours}, true, false
		}
	}
	return hookSpan{}, false, true
}

// One read answering everything status/install/uninstall need: the
// reported state plus, for fenced rc files, the parsed lines and span,
// so the mutators below never re-read or re-judge what was just
// inspected. lines/span are unset for fish (the drop-in is replaced or
// removed whole) and when the file is missing.
type hookFile struct {
	state hookState
	lines []string
	span  hookSpan
	found bool
	// A real read failure (not absence). The mutators refuse to touch
	// the file then: writing over content we couldn't see would
	// truncate the user's rc down to just our block.
	readErr error
}

func inspectHook(kind string) hookFile {
	state := hookState{Shell: kind, Path: hookPath(kind), State: "missing"}
	data, err := os.ReadFile(state.Path)
	if err != nil {
		if !os.IsNotExist(err) {
			// Unreadable ≠ absent: report "modified" (hands off), never
			// "missing" (safe to create).
			state.State = "modified"
			return hookFile{state: state, readErr: err}
		}
		return hookFile{state: state}
	}
	if kind == "fish" {
		// The drop-in is wholly managed (namespaced filename, "edits are
		// overwritten" header), so carrying our marker makes it ours, any
		// vintage. Only wholesale replacement counts as modified.
		if strings.Contains(string(data), hookBeginMarker()) {
			state.State = "installed"
		} else {
			state.State = "modified"
		}
		return hookFile{state: state}
	}
	lines := strings.Split(string(data), "\n")
	span, found, broken := findHookSpan(lines)
	switch {
	case broken, found && !span.ours:
		state.State = "modified"
	case found:
		state.State = "installed"
	}
	return hookFile{state: state, lines: lines, span: span, found: found}
}

func hookStateOf(kind string) hookState { return inspectHook(kind).state }

func installHook(kind string) error {
	path := hookPath(kind)
	hook := inspectHook(kind)
	if hook.readErr != nil {
		return errf("Couldn't read %s: %v", collapseHome(path), hook.readErr)
	}
	if hook.state.State == "modified" {
		if kind == "fish" {
			return errf("%s exists but wasn't written by `%s shell install`. Remove it first.", collapseHome(path), binaryName)
		}
		return errf("The %s block in %s was edited. Restore or remove it, then install again.", rootDirName, collapseHome(path))
	}
	if kind == "fish" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return errf("Couldn't create %s: %v", collapseHome(filepath.Dir(path)), err)
		}
		return writeHookFile(path, fishHookContent(), 0o644)
	}
	if !hook.found {
		content := strings.TrimRight(strings.Join(hook.lines, "\n"), "\n")
		if content != "" {
			content += "\n\n"
		}
		return writeHookFile(path, content+hookBlock(kind), rcFileMode(path))
	}
	// Refresh in place: the guard line may name a new shape.
	block := strings.Split(strings.TrimRight(hookBlock(kind), "\n"), "\n")
	lines := append(hook.lines[:hook.span.begin], append(block, hook.lines[hook.span.end+1:]...)...)
	return writeHookFile(path, strings.Join(lines, "\n"), rcFileMode(path))
}

func uninstallHook(kind string) (removed bool, err error) {
	path := hookPath(kind)
	hook := inspectHook(kind)
	if hook.readErr != nil {
		return false, errf("Couldn't read %s: %v", collapseHome(path), hook.readErr)
	}
	switch hook.state.State {
	case "missing":
		return false, nil
	case "modified":
		return false, errf("Left %s alone: its %s block was edited. Remove it by hand.", collapseHome(path), rootDirName)
	}
	if kind == "fish" {
		if err := os.Remove(path); err != nil {
			return false, errf("Couldn't remove %s: %v", collapseHome(path), err)
		}
		return true, nil
	}
	// Take the blank separator line install added along with the block.
	begin := hook.span.begin
	if begin > 0 && strings.TrimSpace(hook.lines[begin-1]) == "" {
		begin--
	}
	lines := append(hook.lines[:begin], hook.lines[hook.span.end+1:]...)
	return true, writeHookFile(path, strings.Join(lines, "\n"), rcFileMode(path))
}

// Preserve an existing rc file's permission bits, 0644 for new files.
func rcFileMode(path string) os.FileMode {
	if info, err := os.Stat(path); err == nil {
		return info.Mode().Perm()
	}
	return 0o644
}

// Atomic replace (temp sibling + rename), the same shape as
// replaceWithSymlinkSync in shared/cliDist.mts: a failed or interrupted
// write must never leave the user's rc truncated.
func writeHookFile(path, content string, mode os.FileMode) error {
	tmp := filepath.Join(filepath.Dir(path),
		fmt.Sprintf(".%s.tmp-%d", filepath.Base(path), os.Getpid()))
	err := os.WriteFile(tmp, []byte(content), mode)
	// WriteFile's mode is masked by the umask on creation, so restore
	// the rc's exact permissions.
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return errf("Couldn't write %s: %v", collapseHome(path), err)
	}
	return nil
}

// --- the subcommands ---

type shellIntegrationStatus struct {
	OK         bool        `json:"ok"`
	LoginShell string      `json:"loginShell"`
	Active     bool        `json:"active"`
	Shells     []hookState `json:"shells"`
}

func currentShellStatus() shellIntegrationStatus {
	status := shellIntegrationStatus{
		OK:         true,
		LoginShell: loginShellKind(),
		Active:     cdDirectiveFile() != "",
	}
	for _, kind := range shellKinds {
		status.Shells = append(status.Shells, hookStateOf(kind))
	}
	return status
}

func cmdShellInstall(args []string) (int, error) {
	if len(args) > 1 {
		return 2, usageErrf("Usage: %s shell install [<zsh|bash|fish>]", binaryName)
	}
	kind := loginShellKind()
	if len(args) == 1 {
		kind = args[0]
		if !slices.Contains(shellKinds, kind) {
			return 2, usageErrf("Unsupported shell %q. Usage: %s shell install [<zsh|bash|fish>]", kind, binaryName)
		}
	} else if kind == "" {
		return 2, usageErrf("Couldn't tell your shell from $SHELL. Usage: %s shell install <zsh|bash|fish>", binaryName)
	}
	if err := installHook(kind); err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(currentShellStatus())
		return 0, nil
	}
	note("Hooked " + cyanErr(binaryName) + " shell integration into " +
		cyanErr(collapseHome(hookPath(kind))) + ".")
	note(dimErr("Takes effect in new shells. Run `exec " + kind + "` to reload this one."))
	return 0, nil
}

// Uninstall sweeps every supported shell: it only ever removes
// recognizably-ours hooks, so scanning configs the user never
// installed into is safe and covers "I switched shells since".
func cmdShellUninstall(args []string) (int, error) {
	if len(args) != 0 {
		return 2, usageErrf("Usage: %s shell uninstall", binaryName)
	}
	removedAny, failed := false, false
	for _, kind := range shellKinds {
		removed, err := uninstallHook(kind)
		if err != nil {
			note(yellowErr(err.Error()))
			failed = true
			continue
		}
		if removed {
			removedAny = true
			if !jsonMode {
				note("Removed the hook from " + cyanErr(collapseHome(hookPath(kind))) + ".")
			}
		}
	}
	if jsonMode {
		emit(currentShellStatus())
	} else if !removedAny && !failed {
		note("No shell integration hooks were installed.")
	} else if removedAny {
		note(dimErr("Shells already running keep the wrapper until they restart."))
	}
	if failed {
		return 1, nil // already reported per shell
	}
	return 0, nil
}

func cmdShellStatus(args []string) (int, error) {
	if len(args) != 0 {
		return 2, usageErrf("Usage: %s shell status", binaryName)
	}
	status := currentShellStatus()
	if jsonMode {
		emit(status)
		return 0, nil
	}
	rows := make([][]string, 0, len(status.Shells))
	installedAnywhere := false
	for _, shell := range status.Shells {
		var label string
		switch shell.State {
		case "installed":
			installedAnywhere = true
			label = greenOut("installed")
		case "modified":
			label = yellowOut("edited")
		default:
			label = dimOut("not installed")
		}
		name := shell.Shell
		if shell.Shell == status.LoginShell {
			name += " *"
		}
		rows = append(rows, []string{name, label, dimOut(collapseHome(shell.Path))})
	}
	out(renderTable([]string{"shell", "hook", "config"}, rows))
	if status.LoginShell != "" {
		out(dimOut("* login shell"))
	}
	if status.Active {
		out("Active in this session: " + greenOut("yes"))
	} else if installedAnywhere {
		out("Active in this session: no " + dimOut("(restart the shell, or it was started before install)"))
	} else {
		out("Run `" + binaryName + " shell install` to stop cd/create from nesting subshells.")
	}
	return 0, nil
}
