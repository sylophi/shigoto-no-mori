package main

// Interactive worktree selection for commands run from the primary
// checkout without naming a target. Only there: inside a non-primary
// worktree the cwd already picks the target, and outside a repo the
// explicit forms are required. The menu renders on stderr and the
// answer is read from stdin, so stdout stays clean for the command's
// result -- `cd "$(sgm path)"` opens the picker and still cd's.
// Never triggers for --json or when stdin/stderr isn't a terminal, so
// agents and pipelines keep the old deterministic behavior (the
// primary itself).

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

func canPickInteractively() bool {
	return !jsonMode && isTerminal(os.Stdin) && isTerminal(os.Stderr)
}

func pickWorktree(proj project) (located, error) {
	worktrees, err := listWorktrees(proj)
	if err != nil {
		return located{}, err
	}
	var choices []worktreeJSON
	for _, w := range worktrees {
		if !w.IsPrimary {
			choices = append(choices, w)
		}
	}
	if len(choices) == 0 {
		return located{}, errf("%s has no worktrees besides the primary. Create one with `%s create`.",
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

	reader := bufio.NewReader(os.Stdin)
	for {
		fmt.Fprintf(os.Stderr, "Worktree [1-%d]: ", len(choices))
		input, err := reader.ReadString('\n')
		if err != nil {
			note("")
			return located{}, errf("Cancelled.")
		}
		answer := strings.TrimSpace(input)
		if answer == "" || strings.EqualFold(answer, "q") {
			return located{}, errf("Cancelled.")
		}
		var chosen *worktreeJSON
		if n, convErr := strconv.Atoi(answer); convErr == nil && n >= 1 && n <= len(choices) {
			chosen = &choices[n-1]
		} else {
			for i, w := range choices {
				if strings.EqualFold(w.Name, answer) {
					chosen = &choices[i]
					break
				}
			}
		}
		if chosen == nil {
			note(fmt.Sprintf("Enter a number between 1 and %d, a worktree name, or blank to cancel.", len(choices)))
			continue
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
}
