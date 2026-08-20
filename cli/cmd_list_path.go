package main

// sm worktrees list + sm worktrees path.

import (
	"fmt"
	"strings"
	"sync"
)

// Cell colors follow the app's semantic families (emerald=success,
// amber=warning, sky=info); the words alone carry the meaning when
// color is off. Palette-parameterized because the picker renders the
// same cells on stderr.
// The ↑ahead ↓behind cell. Shared with the status card so a table row
// and a card can't describe the same divergence differently. even is
// the label for "no divergence at all".
func divergenceCell(p palette, ahead, behind int, even string) string {
	if ahead == 0 && behind == 0 {
		return p.green(even)
	}
	cell := ""
	if ahead > 0 {
		cell = p.cyan(fmt.Sprintf("↑%d", ahead))
	}
	if behind > 0 {
		if cell != "" {
			cell += " "
		}
		cell += p.yellow(fmt.Sprintf("↓%d", behind))
	}
	return cell
}

func syncCell(p palette, w worktreeJSON) string {
	if w.Detached {
		return p.yellow("detached")
	}
	if !w.HasUpstream {
		return p.dim("local")
	}
	return divergenceCell(p, w.Ahead, w.Behind, "synced")
}

// primary before external, and never both: the primary checkout isn't
// under the managed base either, and calling it external would only
// confuse. Shared with the status card's header.
func worktreeFlags(isPrimary, isExternal, shelved bool) []string {
	var flags []string
	if isPrimary {
		flags = append(flags, "primary")
	} else if isExternal {
		flags = append(flags, "external")
	}
	if shelved {
		flags = append(flags, "shelved")
	}
	return flags
}

func flagsCell(p palette, w worktreeJSON) string {
	return p.dim(strings.Join(worktreeFlags(w.IsPrimary, w.IsExternal, w.Shelved), ", "))
}

func changesCell(p palette, w worktreeJSON) string {
	if w.ChangedCount > 0 {
		return p.yellow(fmt.Sprintf("%d changed", w.ChangedCount))
	}
	return p.dim("clean")
}

func cmdList(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
		bools:   map[string][]string{"all": {"a"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}

	if len(ctx.projects) == 0 {
		return 1, errf("No projects are registered yet -- add a repo in the Shigoto no Mori app first.")
	}

	scope := ctx.projects
	if !parsed.bools["all"] && (parsed.strings["project"] != "" || ctx.current != nil) {
		proj, err := resolveProject(ctx, parsed.strings["project"])
		if err != nil {
			return exitCodeOf(err), err
		}
		scope = []project{proj}
	}

	// Accent colors need per-project git+icon work; overlap it with
	// the worktree listing fan-out. Skipped when the colors would be
	// painted away (piped stdout, --json, NO_COLOR) or the PROJECT
	// column won't render (single-project scope).
	accentsReady := make(chan struct{})
	if !jsonMode && stdoutColor && len(scope) > 1 {
		go func() {
			prefetchProjectColors(scope)
			close(accentsReady)
		}()
	} else {
		close(accentsReady)
	}

	type projectResult struct {
		proj      project
		worktrees []worktreeJSON
		err       error
	}
	results := make([]projectResult, len(scope))
	var wg sync.WaitGroup
	for i, proj := range scope {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worktrees, err := listWorktrees(proj)
			results[i] = projectResult{proj: proj, worktrees: worktrees, err: err}
		}()
	}
	wg.Wait()

	// results is indexed by scope position, so collected keeps scope
	// order without any re-sort.
	var collected []projectResult
	for _, r := range results {
		if r.err != nil {
			note(fmt.Sprintf("warning: skipping %s: %s", r.proj.Name, r.err))
			continue
		}
		collected = append(collected, r)
	}

	if jsonMode {
		flat := []worktreeJSON{}
		for _, r := range collected {
			flat = append(flat, r.worktrees...)
		}
		emit(flat)
		return 0, nil
	}

	multi := len(collected) > 1
	// Only block on the accent fan-out when its result will actually
	// paint something -- multi can come up false (errors, empty
	// projects) even though the prefetch was started.
	if multi && stdoutColor {
		<-accentsReady
	}
	currentID := ""
	if ctx.current != nil {
		currentID = ctx.current.worktree.ID
	}
	header := []string{"", "NAME", "BRANCH", "SYNC", "CHANGES", ""}
	if multi {
		header = []string{"", "PROJECT", "NAME", "BRANCH", "SYNC", "CHANGES", ""}
	}
	var rows [][]string
	for _, r := range collected {
		for _, w := range r.worktrees {
			marker := ""
			if w.ID == currentID {
				marker = cyanOut("@")
			}
			row := []string{
				marker, w.Name, w.Branch,
				syncCell(outPalette, w), changesCell(outPalette, w), flagsCell(outPalette, w),
			}
			if multi {
				projectCell := r.proj.Name
				if stdoutColor {
					projectCell = codeOut(projectCell, projectColorCode(r.proj))
				}
				row = append([]string{marker, projectCell}, row[1:]...)
			}
			rows = append(rows, row)
		}
	}
	if len(rows) == 0 {
		note("No worktrees found.")
		return 0, nil
	}
	out(renderTable(header, rows))
	return 0, nil
}

func cmdPath(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{
			"id":          target.worktree.ID,
			"name":        target.worktree.Name,
			"branch":      target.worktree.Branch,
			"path":        target.worktree.Path,
			"projectName": target.proj.Name,
			"projectId":   target.proj.ID,
			"isPrimary":   target.worktree.IsPrimary,
		})
	} else {
		out(target.worktree.Path)
	}
	return 0, nil
}
