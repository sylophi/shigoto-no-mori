package main

// sm cd / sm worktree (wt) -- drop into a worktree in a subshell. A
// child process can't change its parent shell's directory, so these
// start $SHELL in the target and exiting it returns you to where you
// were. Both accept an explicit <name>; the difference is the bare
// form: `cd` navigates anywhere (project menu first, current project
// preselected), `worktree` stays in the current project and only asks
// which worktree. Scripts should use `cd "$(sm path <name>)"`
// instead; both commands require an interactive terminal.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func cmdCd(ctx cliContext, args []string) (int, error) {
	return cmdEnterWorktree(ctx, args, true)
}

func cmdWorktree(ctx cliContext, args []string) (int, error) {
	return cmdEnterWorktree(ctx, args, false)
}

// sm worktrees <command> (wt, worktree for short) -- namespace form
// of the bare worktree commands, mirroring `sm projects <command>`.
// Bare `sm worktrees` prints the namespace help; a worktree name
// enters that worktree (`switch` with the menu). Subcommand words win
// over worktree names.
func cmdWorktrees(ctx cliContext, args []string) (int, error) {
	if len(args) == 0 {
		out(worktreesHelpText())
		return 0, nil
	}
	{
		sub, rest := args[0], args[1:]
		switch sub {
		case "switch":
			return cmdWorktree(ctx, rest)
		case "list", "ls", "l":
			return cmdList(ctx, rest)
		case "path":
			return cmdPath(ctx, rest)
		case "cd", "c":
			return cmdCd(ctx, rest)
		case "open", "o":
			return cmdOpen(ctx, rest)
		case "create", "new":
			return cmdCreate(ctx, rest)
		case "rm", "remove":
			return cmdRm(ctx, rest)
		case "done":
			return cmdDone(ctx, rest)
		case "merge":
			return cmdMerge(ctx, rest)
		case "adopt":
			return cmdAdopt(ctx, rest)
		case "setup":
			return cmdSetup(ctx, rest)
		case "shelve":
			return cmdShelve(ctx, rest, true)
		case "unshelve":
			return cmdShelve(ctx, rest, false)
		}
	}
	return cmdWorktree(ctx, args)
}

func cmdEnterWorktree(ctx cliContext, args []string, acrossProjects bool) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if !interactiveStdio() {
		return 2, usageErrf(
			`This command opens a subshell and needs an interactive terminal. In scripts use cd "$(%s path <name>)".`,
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
		// Always a menu here, even inside a worktree: entering where
		// you already are isn't a destination. NOTE: assign through the
		// outer err -- a shadowed err here once let a cancelled picker
		// fall through to a zero-value target.
		var proj project
		switch {
		case parsed.strings["project"] != "":
			proj, err = resolveProject(ctx, parsed.strings["project"])
		case acrossProjects && len(ctx.projects) > 1:
			preferred := ""
			if ctx.current != nil {
				preferred = ctx.current.proj.ID
			}
			proj, err = pickProject(ctx, preferred)
		default:
			// Current project when inside one, else the project menu.
			proj, err = resolveProject(ctx, "")
		}
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
	cmd.Env = append(os.Environ(), "SHIGOMORI_WORKTREE="+target.worktree.Name)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		return 1, errf("Couldn't start %s: %v", shell, err)
	}
	return 0, nil
}
