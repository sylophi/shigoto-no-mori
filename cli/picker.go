package main

// The pickers behind every command that can be run without naming its
// target: they build the rows and hand them to menuSelect (menu.go)
// for arrow-key selection. Everything renders on stderr and the answer
// comes from stdin, so stdout stays clean for the command's result --
// `cd "$(sgm path)"` opens the picker and still cd's. Nothing here
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

func pickProject(ctx cliContext) (project, error) {
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
	for i, p := range ctx.projects {
		pad := strings.Repeat(" ", widest-len([]rune(p.Name)))
		rows[i] = p.Name + pad + "  " + p.Path
		names[i] = p.Name
	}
	idx, err := menuSelect("Select a project:", rows, names)
	if err != nil {
		return project{}, err
	}
	return ctx.projects[idx], nil
}

// excludeID drops one worktree from the menu -- the one the caller is
// already in (for the primary-checkout default that's the primary, for
// `cd` it's wherever you stand).
func pickWorktree(proj project, excludeID string) (located, error) {
	worktrees, err := listWorktrees(proj)
	if err != nil {
		return located{}, err
	}
	var choices []worktreeJSON
	for _, w := range worktrees {
		if w.ID != excludeID {
			choices = append(choices, w)
		}
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
	widths := make([]int, len(cells[0]))
	for _, row := range cells {
		for i, cell := range row {
			if n := visibleWidth(cell); n > widths[i] {
				widths[i] = n
			}
		}
	}
	rows := make([]string, len(choices))
	names := make([]string, len(choices))
	for r, row := range cells {
		line := ""
		for i, cell := range row {
			line += cell + strings.Repeat(" ", widths[i]-visibleWidth(cell)) + "  "
		}
		rows[r] = strings.TrimRight(line, " ")
		names[r] = choices[r].Name
	}

	idx, err := menuSelect("Select a worktree in "+proj.Name+":", rows, names)
	if err != nil {
		return located{}, err
	}
	chosen := choices[idx]
	// Round-trip through identities so the located carries the same
	// struct every other resolver hands out.
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return located{}, err
	}
	for _, id := range identities {
		if id.ID == chosen.ID {
			return located{proj: proj, worktree: id}, nil
		}
	}
	return located{}, errf("Worktree %q disappeared while picking.", chosen.Name)
}
