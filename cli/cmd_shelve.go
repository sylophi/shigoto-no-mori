package main

// sm shelve / unshelve: the app's "out of focus" flag. Pure UI state
// in state.json -- nothing on disk changes. The primary checkout and
// external worktrees can't be shelved.

func cmdShelve(ctx cliContext, args []string, shelved bool) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, false)
	if err != nil {
		return exitCodeOf(err), err
	}
	id := target.worktree
	if shelved && id.IsPrimary {
		return 1, errf("The primary checkout can't be shelved")
	}
	if shelved && id.IsExternal {
		return 1, errf("External worktrees can't be shelved")
	}
	if err := setShelved(id.ID, shelved); err != nil {
		return 1, err
	}
	verb := "shelved"
	if !shelved {
		verb = "unshelved"
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "name": id.Name, "id": id.ID, "shelved": shelved})
	} else {
		out(greenOut(verb + " " + id.Name))
	}
	return 0, nil
}
