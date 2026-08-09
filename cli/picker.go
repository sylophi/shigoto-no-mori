package main

// The pickers behind every command that can be run without naming its
// target: they build the rows and hand them to menuSelect (menu.go)
// for arrow-key selection. Everything renders on stderr and the answer
// comes from stdin, so stdout stays clean for the command's result --
// `cd "$(sm path)"` opens the picker and still cd's. Nothing here
// triggers for --json or when stdin/stderr isn't a terminal, so agents
// and pipelines keep deterministic behavior.

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func interactiveStdio() bool {
	return !jsonMode && isTerminal(os.Stdin) && isTerminal(os.Stderr)
}

// Yes/no question on stderr, default no. EOF (ctrl-d) counts as no.
func confirmPrompt(question string) bool {
	fmt.Fprintf(os.Stderr, "%s [y/N] ", question)
	input, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		note("")
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(input))
	return answer == "y" || answer == "yes"
}

// preferredID highlights that project first (e.g. the one containing
// cwd), so enter alone keeps you where you are.
func pickProject(ctx cliContext, preferredID string) (project, error) {
	if len(ctx.projects) == 0 {
		return project{}, errf("No projects are registered yet.")
	}
	widest := 0
	for _, p := range ctx.projects {
		if n := len([]rune(p.Name)); n > widest {
			widest = n
		}
	}
	rows := make([]string, len(ctx.projects))
	names := make([]string, len(ctx.projects))
	initial := 0
	for i, p := range ctx.projects {
		pad := strings.Repeat(" ", widest-len([]rune(p.Name)))
		rows[i] = p.Name + pad + "  " + p.Path
		names[i] = p.Name
		if p.ID == preferredID {
			initial = i
		}
	}
	idx, err := menuSelect("Select a project:", rows, names, initial)
	if err != nil {
		return project{}, err
	}
	return ctx.projects[idx], nil
}

// excludeID drops one worktree from the menu -- for `cd` that's
// wherever you stand, since entering it again isn't a destination.
// primaryOK=false additionally drops the primary checkout, for
// commands that would refuse it anyway (rm, adopt, shelve).
// primaryLast moves the primary to the bottom so it never sits on the
// initial highlight -- for menus shown FROM the primary, where a real
// worktree is the likely target but the primary must stay reachable.
type pickOpts struct {
	excludeID   string
	primaryOK   bool
	primaryLast bool
}

func pickWorktree(proj project, opts pickOpts) (located, error) {
	worktrees, err := listWorktrees(proj)
	if err != nil {
		return located{}, err
	}
	var choices []worktreeJSON
	for _, w := range worktrees {
		if w.ID != opts.excludeID && (opts.primaryOK || !w.IsPrimary) {
			choices = append(choices, w)
		}
	}
	if opts.primaryLast {
		ordered := make([]worktreeJSON, 0, len(choices))
		for _, w := range choices {
			if !w.IsPrimary {
				ordered = append(ordered, w)
			}
		}
		for _, w := range choices {
			if w.IsPrimary {
				ordered = append(ordered, w)
			}
		}
		choices = ordered
	}
	if len(choices) == 0 {
		return located{}, errf("%s has no other worktrees. Create one with `%s create`.",
			proj.Name, binaryName)
	}

	cells := make([][]string, len(choices))
	for i, w := range choices {
		cells[i] = []string{
			w.Name,
			w.Branch,
			syncCell(plainPalette, w),
			changesCell(plainPalette, w),
			flagsCell(plainPalette, w),
		}
	}
	rows := alignRows(cells)
	names := make([]string, len(choices))
	for i, w := range choices {
		names[i] = w.Name
	}

	idx, err := menuSelect("Select a worktree in "+proj.Name+":", rows, names, 0)
	if err != nil {
		return located{}, err
	}
	// The status object already carries every identity field; no
	// re-listing round trip needed.
	return located{proj: proj, worktree: identityOf(choices[idx])}, nil
}
