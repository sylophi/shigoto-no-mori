package main

// Interactive menus, shared by every command that can be run without
// naming its target. Menus render on stderr and the answer is read
// from stdin, so stdout stays clean for the command's result --
// `cd "$(sgm path)"` opens the picker and still cd's. Nothing here
// triggers for --json or when stdin/stderr isn't a terminal, so agents
// and pipelines keep deterministic behavior.

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func interactiveStdio() bool {
	return !jsonMode && isTerminal(os.Stdin) && isTerminal(os.Stderr)
}

// Reads a selection from stdin: a 1-based number or a name
// (case-insensitive), blank or q cancels. The caller has already
// printed the numbered menu.
func promptChoice[T any](items []T, noun string, nameOf func(T) string) (*T, error) {
	reader := bufio.NewReader(os.Stdin)
	for {
		fmt.Fprintf(os.Stderr, "%s [1-%d]: ", noun, len(items))
		input, err := reader.ReadString('\n')
		if err != nil {
			note("")
			return nil, errf("Cancelled.")
		}
		answer := strings.TrimSpace(input)
		if answer == "" || strings.EqualFold(answer, "q") {
			return nil, errf("Cancelled.")
		}
		if n, convErr := strconv.Atoi(answer); convErr == nil && n >= 1 && n <= len(items) {
			return &items[n-1], nil
		}
		for i := range items {
			if strings.EqualFold(nameOf(items[i]), answer) {
				return &items[i], nil
			}
		}
		note(fmt.Sprintf("Enter a number between 1 and %d, a name, or blank to cancel.", len(items)))
	}
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
	note("Select a project:")
	note("")
	widest := 0
	for _, p := range ctx.projects {
		if n := len([]rune(p.Name)); n > widest {
			widest = n
		}
	}
	for i, p := range ctx.projects {
		pad := strings.Repeat(" ", widest-len([]rune(p.Name)))
		note(fmt.Sprintf("  %s  %s%s  %s",
			dimErr(strconv.Itoa(i+1)+"."), cyanErr(p.Name), pad, dimErr(p.Path)))
	}
	note("")
	chosen, err := promptChoice(ctx.projects, "Project", func(p project) string { return p.Name })
	if err != nil {
		return project{}, err
	}
	return *chosen, nil
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

	note("Select a worktree in " + proj.Name + ":")
	note("")
	rows := make([][]string, len(choices))
	for i, w := range choices {
		rows[i] = []string{
			dimErr(strconv.Itoa(i+1) + "."),
			cyanErr(w.Name),
			w.Branch,
			syncCell(errPalette, w),
			changesCell(errPalette, w),
			flagsCell(errPalette, w),
		}
	}
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for i, cell := range row {
			if n := visibleWidth(cell); n > widths[i] {
				widths[i] = n
			}
		}
	}
	for _, row := range rows {
		line := "  "
		for i, cell := range row {
			line += cell + strings.Repeat(" ", widths[i]-visibleWidth(cell)) + "  "
		}
		note(strings.TrimRight(line, " "))
	}
	note("")

	chosen, err := promptChoice(choices, "Worktree", func(w worktreeJSON) string { return w.Name })
	if err != nil {
		return located{}, err
	}
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
