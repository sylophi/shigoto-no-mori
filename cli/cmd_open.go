package main

// sm open runs a tool from the app's launcher row in a worktree.
// `sm open finder` (label or id, case-insensitive) launches directly;
// bare `sm open` shows the row as a menu, ordered like the app (by
// recent use, then label). The target worktree is the one containing
// cwd (the primary counts, since opening the primary in Finder is a
// normal thing to want), a second positional names one explicitly, and
// from outside any repo the menus ask project then worktree.
//
// The app launches through here too, by exact address: `sm --json open
// --project-id P --worktree-id W -- <launcher id>` (app:<id>,
// custom:<id>, web:github). The CLI launches and bumps the launcher use
// log; the answer is {ok, launcher, worktree}, and any failure
// (unknown worktree or tool, a launch that failed) is the usual
// {ok: false, error, code?} document.

import (
	"fmt"
	"slices"
	"strings"
)

func cmdOpen(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	tool := parsed.positional(0)

	var target located
	switch {
	case parsed.strings["worktree-id"] != "":
		if len(parsed.positionals) > 1 {
			return 2, usageErrf("Pass either a worktree name or --worktree-id, not both.")
		}
		target, err = resolveWorktreeByID(ctx, parsed.strings["project-id"], parsed.strings["worktree-id"])
	case parsed.strings["project-id"] != "":
		return 2, usageErrf("--project-id scopes --worktree-id; pass both (or -p <project> with a name).")
	case len(parsed.positionals) > 1:
		target, err = resolveWorktree(ctx, parsed.positionals[1], parsed.strings["project"], true)
	case ctx.current != nil && parsed.strings["project"] == "":
		target = *ctx.current
	default:
		if !interactiveStdio() {
			return 2, usageErrf("Not inside a worktree; pass one: %s open <tool> <name>.", binaryName)
		}
		// resolveProject supplies the project menu when cwd isn't in
		// one (or honors -p), then the worktree menu picks the target.
		var proj project
		proj, err = resolveProject(ctx, parsed.strings["project"])
		if err != nil {
			return exitCodeOf(err), err
		}
		target, err = pickWorktree(proj, pickOpts{primaryOK: true})
	}
	if err != nil {
		return exitCodeOf(err), err
	}

	entries := availableLaunchers(target.proj)
	var chosen *launcherEntry
	if tool == "" {
		if !interactiveStdio() {
			return 2, usageErrf("Pass a tool to open (see the menu by running `%s open` in a terminal).", binaryName)
		}
		chosen, err = pickLauncher(entries, target.worktree.Name)
		if err != nil {
			return exitCodeOf(err), err
		}
	} else {
		chosen = matchLauncher(entries, tool)
		if chosen == nil {
			labels := joinMapped(entries, func(e launcherEntry) string { return e.label })
			return 1, codedErrf("unknown-launcher", "Unknown tool %q. Available: %s.", tool, labels)
		}
	}

	if err := launchEntryFn(*chosen, target.worktree.Path); err != nil {
		return 1, errf("Couldn't open %s: %v", chosen.label, err)
	}
	bumpLauncherUse(chosen.id)
	emitOrOut(map[string]any{"ok": true, "launcher": chosen.id, "worktree": target.worktree.Name},
		fmt.Sprintf("opened %s in %s", chosen.label, target.worktree.Name))
	return 0, nil
}

// Test seam: tests check which entry an address resolves to without
// launching anything.
var launchEntryFn = launchEntry

// Full id (the app's exact address), then label or bare catalog id
// ("finder" for app:finder), all case-insensitive. The full-id pass
// comes first so a custom launcher labeled like another's id can't
// shadow it. Hidden launchers still match: hiding is presentational,
// same as the app.
func matchLauncher(entries []launcherEntry, tool string) *launcherEntry {
	for i := range entries {
		if strings.EqualFold(entries[i].id, tool) {
			return &entries[i]
		}
	}
	for i := range entries {
		e := &entries[i]
		if strings.EqualFold(e.label, tool) || strings.EqualFold(e.id, tool) {
			return e
		}
		if cut := strings.Index(e.id, ":"); cut >= 0 && strings.EqualFold(e.id[cut+1:], tool) {
			return e
		}
	}
	return nil
}

func pickLauncher(entries []launcherEntry, worktreeName string) (*launcherEntry, error) {
	hidden := map[string]bool{}
	for _, id := range readGlobalConfigHints().HiddenLaunchers {
		hidden[id] = true
	}
	visible := slices.DeleteFunc(slices.Clone(entries), func(e launcherEntry) bool { return hidden[e.id] })
	if len(visible) == 0 {
		return nil, errf("No launchers available.")
	}
	sortLaunchersByUse(visible)

	cells := make([][]string, len(visible))
	names := make([]string, len(visible))
	for i, e := range visible {
		kind := ""
		switch {
		case e.custom != nil:
			kind = "(custom)"
		case e.webURL != "":
			kind = "(web)"
		}
		cells[i] = []string{e.label, dimErr(kind)}
		names[i] = e.label
	}
	_, rows := buildMenu(nil, cells)
	idx, err := menuSelect("Open "+worktreeName+" in:", "", rows, names, 0)
	if err != nil {
		return nil, err
	}
	return &visible[idx], nil
}
