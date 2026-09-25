package main

// sm shelve / unshelve: the app's "out of focus" flag. Pure UI state
// in registry.json. Nothing on disk changes. The primary checkout and
// external worktrees can't be shelved.

func cmdShelve(ctx cliContext, args []string, shelved bool) (int, error) {
	_, target, err := parseWorktreeArgs(ctx, args, worktreeTargetSpec(), false)
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
	emitOrOut(map[string]any{"ok": true, "name": id.Name, "id": id.ID, "shelved": shelved},
		greenOut(verb+" "+id.Name))
	return 0, nil
}

// sm autopull [on|off] [<name>]: the app's "follow the remote" mark
// (registry.json autoPullKey). While it is set, the running app
// fast-forwards the worktree onto its upstream after each background
// fetch. The CLI only owns the mark. Any checkout can carry it, the
// primary most of all. With no on/off it reports the current state.
// --json answers with the worktree's row either way, so the app's
// toggle gets the updated row back in the same round trip.
func cmdAutoPull(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	mode := ""
	if first := parsed.positional(0); first == "on" || first == "off" {
		mode = first
		parsed.positionals = parsed.positionals[1:]
	}
	if len(parsed.positionals) > 1 {
		return 2, usageErrf("Usage: %s autopull [on|off] [<name>]", binaryName)
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	id := target.worktree
	if mode != "" {
		if err := setRegistryMark(autoPullKey, id.ID, mode == "on"); err != nil {
			return 1, err
		}
	}
	if jsonMode {
		row := buildWorktree(target.proj, id, loadBuildContext(target.proj))
		emit(map[string]any{"ok": true, "worktree": row})
		return 0, nil
	}
	state := "off"
	if readRegistryMarkSet(autoPullKey)[id.ID] {
		state = "on"
	}
	if mode == "" {
		out(id.Name + ": auto-pull " + state)
	} else {
		out(greenOut("auto-pull " + state + " for " + id.Name))
	}
	return 0, nil
}
