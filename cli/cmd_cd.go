package main

// sm cd / sm worktree (wt) -- drop into a worktree. A child process
// can't change its parent shell's directory, so by default these start
// $SHELL in the target and exiting it returns you to where you were.
// With shell integration active (cmd_shell.go), the wrapper's
// directive file lets the calling shell cd instead -- no nesting.
// Both accept an explicit <name>. The difference is the bare form:
// `cd` navigates anywhere (project menu first, current project
// preselected), `worktree` stays in the current project and only asks
// which worktree. Scripts should use `cd "$(sm path <name>)"` instead.

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
		out(namespaceHelp("worktrees"))
		return 0, nil
	}
	if cmd := lookupCommand(args[0]); cmd != nil && cmd.worktree {
		return cmd.run(ctx, args[1:])
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
	ref := parsed.positional(0)
	// The subshell and the menus need a terminal. A wrapper-provided
	// directive file with an explicit name needs neither. --json stays
	// refused outright: a cd that emits no documents yet moves the
	// caller's shell would break every NDJSON consumer.
	if jsonMode || (!interactiveStdio() && (cdDirectiveFile() == "" || ref == "")) {
		return 2, usageErrf(
			`This command opens a subshell and needs an interactive terminal. In scripts use cd "$(%s path <name>)".`,
			binaryName)
	}
	var target located
	if ref != "" {
		target, err = resolveWorktree(ctx, ref, parsed.strings["project"], true)
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
		target, err = pickWorktree(proj, pickOpts{excludeID: exclude, primaryOK: true})
	}
	if err != nil {
		return exitCodeOf(err), err
	}
	// The menus exclude the worktree you stand in, but an explicit ref
	// (`sm cd root` from the primary) can still name it -- a nested
	// shell in the same directory helps nobody.
	if ctx.current != nil && target.worktree.ID == ctx.current.worktree.ID {
		note("Already in " + cyanErr(target.worktree.Name) + " " + dimErr("("+target.worktree.Path+")") + ".")
		return 0, nil
	}

	return enterWorktreeShell(target.worktree.Name, target.worktree.Path)
}

// Move the user's shell into a worktree: through the shell-integration
// directive file when the wrapper provided one, else by starting
// $SHELL there and passing through its exit code. Shared by cd/switch
// and create's drop-into-the-new-worktree tail.
func enterWorktreeShell(name, path string) (int, error) {
	if cdFile := cdDirectiveFile(); cdFile != "" {
		// A raw path only -- the wrapper never parses this as shell.
		if err := os.WriteFile(cdFile, []byte(path+"\n"), 0o600); err == nil {
			note("Entering " + cyanErr(name) + " " + dimErr("("+path+")") + ".")
			return 0, nil
		}
		// Couldn't write the directive, so the subshell still gets them there.
	}
	shell, _ := resolveShell()
	note(fmt.Sprintf("Entering %s %s -- exit the shell to return.",
		cyanErr(name), dimErr("("+path+")")))
	cmd := exec.Command(shell)
	cmd.Dir = path
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(envWithoutCdFile(), "SHIGOMORI_WORKTREE="+name)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		return 1, errf("Couldn't start %s: %v", shell, err)
	}
	return 0, nil
}
