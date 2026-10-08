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

// An on/off mark in registry.json keyed by worktree id, set and shown
// by `sm <verb> [on|off] [<name>]`. With no on/off it reports the
// current state. --json answers with the worktree's row either way, so
// the app's toggle gets the updated row back in the same round trip.
type registryMark struct {
	key   string
	verb  string
	label string
	// Only the worktrees a shelf takes can carry it (shelfable).
	shelf bool
}

// sm autopull: the app's "follow the remote" mark. While it is set, the
// running app fast-forwards the worktree onto its upstream after each
// background fetch. The CLI only owns the mark. Any checkout can carry
// it, the primary most of all.
var autoPullMark = registryMark{key: autoPullKey, verb: "autopull", label: "auto-pull"}

// sm agent-working: the mark an agent sets on a worktree it is working
// in, and clears when it hands the work back. Once the app allows agents
// to mark worktrees as working, it keeps the worktree on its own folded
// shelf until then.
var agentWorkingMark = registryMark{key: agentWorkingKey, verb: "agent-working", label: "agent working", shelf: true}

func cmdRegistryMark(ctx cliContext, args []string, mark registryMark) (int, error) {
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
		return 2, usageErrf("Usage: %s %s [on|off] [<name>]", binaryName, mark.verb)
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	id := target.worktree
	if mode == "on" && mark.shelf && id.IsPrimary {
		return 1, errf("The primary checkout can't be marked as %s", mark.label)
	}
	if mode == "on" && mark.shelf && id.IsExternal {
		return 1, errf("External worktrees can't be marked as %s", mark.label)
	}
	if mode != "" {
		if err := setRegistryMark(mark.key, id.ID, mode == "on"); err != nil {
			return 1, err
		}
	}
	if jsonMode {
		row := buildWorktree(target.proj, id, loadBuildContext(target.proj))
		emit(map[string]any{"ok": true, "worktree": row})
		return 0, nil
	}
	if mode == "" {
		mode = "off"
		if readRegistryMarkSet(mark.key)[id.ID] {
			mode = "on"
		}
		out(id.Name + ": " + mark.label + " " + mode)
	} else {
		out(greenOut(mark.label + " " + mode + " for " + id.Name))
	}
	return 0, nil
}
