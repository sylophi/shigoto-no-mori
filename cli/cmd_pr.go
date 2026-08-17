package main

// sm pr -- open the worktree's pull request in the browser. Finds the
// PR for the worktree's branch the same way merge does (gh's
// server-side --head filter, any state -- looking at a merged PR is
// normal). --json just reports the PR, and non-darwin prints the URL
// instead of opening it (openConfigFileInEditor parity).

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

func cmdPr(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree
	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out to look up")
	}

	pr, err := findPullRequest(proj.Path, id.Branch)
	if err != nil {
		return 1, err
	}
	if pr == nil {
		return 1, errf("No pull request found for branch %s", id.Branch)
	}

	if jsonMode {
		emit(map[string]any{
			"ok": true, "number": pr.Number, "title": pr.Title,
			"state": pr.State, "isDraft": pr.IsDraft,
			"branch": id.Branch, "url": pr.URL,
		})
		return 0, nil
	}
	label := fmt.Sprintf("PR #%d (%s): %s", pr.Number, strings.ToLower(pr.State), pr.Title)
	if runtime.GOOS != "darwin" {
		out(label)
		out(pr.URL)
		return 0, nil
	}
	if err := exec.Command("open", pr.URL).Run(); err != nil {
		return 1, errf("Couldn't open %s: %v", pr.URL, err)
	}
	out("opened " + label)
	note(dimErr(pr.URL))
	return 0, nil
}
