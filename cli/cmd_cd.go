package main

// sgm cd -- drop into a worktree in a subshell. A child process can't
// change its parent shell's directory, so this starts $SHELL in the
// target and exiting it returns you to where you were. With no name it
// picks interactively: the worktree menu scoped to the current repo
// (or -p), and from outside any repo a project menu first. Scripts
// should use `cd "$(sgm path <name>)"` instead; this command requires
// an interactive terminal.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func cmdCd(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if !interactiveStdio() {
		return 2, usageErrf(
			`cd opens a subshell and needs an interactive terminal. In scripts use cd "$(%s path <name>)".`,
			binaryName)
	}

	ref := ""
	if len(parsed.positionals) > 0 {
		ref = parsed.positionals[0]
	}
	var target located
	if ref != "" {
		target, err = resolveWorktree(ctx, ref, parsed.strings["project"])
	} else {
		// Always a menu here, even inside a worktree: cd'ing to where
		// you already are isn't a destination. resolveProject supplies
		// the project menu when cwd isn't in one. NOTE: assign, don't
		// `:=` -- a shadowed err here once let a cancelled picker fall
		// through to a zero-value target.
		var proj project
		proj, err = resolveProject(ctx, parsed.strings["project"])
		if err != nil {
			return exitCodeOf(err), err
		}
		exclude := ""
		if ctx.current != nil && ctx.current.proj.ID == proj.ID {
			exclude = ctx.current.worktree.ID
		}
		target, err = pickWorktree(proj, exclude)
	}
	if err != nil {
		return exitCodeOf(err), err
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	note(fmt.Sprintf("Entering %s %s -- exit the shell to return.",
		cyanErr(target.worktree.Name), dimErr("("+target.worktree.Path+")")))
	cmd := exec.Command(shell)
	cmd.Dir = target.worktree.Path
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "SGM_WORKTREE="+target.worktree.Name)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		return 1, errf("Couldn't start %s: %v", shell, err)
	}
	return 0, nil
}
