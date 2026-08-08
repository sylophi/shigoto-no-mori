package main

// sgm list + sgm path.

import (
	"fmt"
	"sort"
	"sync"
)

func syncCell(w worktreeJSON) string {
	if w.Detached {
		return "detached"
	}
	if !w.HasUpstream {
		return "local"
	}
	if w.Ahead == 0 && w.Behind == 0 {
		return "synced"
	}
	cell := ""
	if w.Ahead > 0 {
		cell = fmt.Sprintf("↑%d", w.Ahead)
	}
	if w.Behind > 0 {
		if cell != "" {
			cell += " "
		}
		cell += fmt.Sprintf("↓%d", w.Behind)
	}
	return cell
}

func flagsCell(w worktreeJSON) string {
	flags := ""
	if w.IsPrimary {
		flags = "primary"
	} else if w.IsExternal {
		flags = "external"
	}
	if w.Shelved {
		if flags != "" {
			flags += ", "
		}
		flags += "shelved"
	}
	return flags
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

	var scope []project
	switch {
	case parsed.bools["all"]:
		scope = ctx.projects
	case parsed.strings["project"] != "" || ctx.current != nil:
		proj, err := resolveProject(ctx, parsed.strings["project"])
		if err != nil {
			return exitCodeOf(err), err
		}
		scope = []project{proj}
	default:
		scope = ctx.projects
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

	var collected []projectResult
	for _, r := range results {
		if r.err != nil {
			note(fmt.Sprintf("warning: skipping %s: %s", r.proj.Name, r.err))
			continue
		}
		collected = append(collected, r)
	}
	sort.SliceStable(collected, func(a, b int) bool {
		return indexOfProject(scope, collected[a].proj.ID) < indexOfProject(scope, collected[b].proj.ID)
	})

	if jsonMode {
		flat := []worktreeJSON{}
		for _, r := range collected {
			flat = append(flat, r.worktrees...)
		}
		emit(flat)
		return 0, nil
	}

	multi := len(collected) > 1
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
				marker = "@"
			}
			changes := "clean"
			if w.ChangedCount > 0 {
				changes = fmt.Sprintf("%d changed", w.ChangedCount)
			}
			row := []string{marker, w.Name, w.Branch, syncCell(w), changes, flagsCell(w)}
			if multi {
				row = append([]string{marker, r.proj.Name}, row[1:]...)
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

func indexOfProject(scope []project, id string) int {
	for i, p := range scope {
		if p.ID == id {
			return i
		}
	}
	return len(scope)
}

func cmdPath(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	ref := ""
	if len(parsed.positionals) > 0 {
		ref = parsed.positionals[0]
	}
	target, err := resolveWorktree(ctx, ref, parsed.strings["project"])
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
