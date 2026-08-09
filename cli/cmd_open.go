package main

// sgm open -- launch a tool from the app's launcher row in a worktree.
// `sgm open finder` (label or id, case-insensitive) launches directly;
// bare `sgm open` shows the row as a menu, ordered like the app (by
// recent use, then label). The target worktree is the one containing
// cwd (the primary counts -- opening the primary in Finder is a normal
// thing to want), a second positional names one explicitly, and from
// outside any repo the menus ask project then worktree.

import (
	"fmt"
	"runtime"
	"strings"
)

func cmdOpen(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if runtime.GOOS != "darwin" {
		return 1, errf("open is only supported on macOS.")
	}

	tool := ""
	if len(parsed.positionals) > 0 {
		tool = parsed.positionals[0]
	}

	var target located
	switch {
	case len(parsed.positionals) > 1:
		target, err = resolveWorktree(ctx, parsed.positionals[1], parsed.strings["project"])
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
		target, err = pickWorktree(proj, "")
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
			labels := make([]string, len(entries))
			for i, e := range entries {
				labels[i] = e.label
			}
			return 1, errf("Unknown tool %q. Available: %s.", tool, strings.Join(labels, ", "))
		}
	}

	if err := launchEntry(*chosen, target.worktree.Path); err != nil {
		return 1, errf("Couldn't open %s: %v", chosen.label, err)
	}
	bumpLauncherUse(chosen.id)
	if jsonMode {
		emit(map[string]any{"ok": true, "launcher": chosen.id, "worktree": target.worktree.Name})
	} else {
		out(fmt.Sprintf("opened %s in %s", chosen.label, target.worktree.Name))
	}
	return 0, nil
}

// Label, full id, or bare catalog id ("finder" for app:finder), all
// case-insensitive. Hidden launchers still match by name -- hiding is
// presentational, same as the app.
func matchLauncher(entries []launcherEntry, tool string) *launcherEntry {
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
	for _, id := range readGlobalConfig().HiddenLaunchers {
		hidden[id] = true
	}
	var visible []launcherEntry
	for _, e := range entries {
		if !hidden[e.id] {
			visible = append(visible, e)
		}
	}
	if len(visible) == 0 {
		return nil, errf("No launchers available.")
	}
	sortLaunchersByUse(visible)

	note("Open " + worktreeName + " in:")
	note("")
	for i, e := range visible {
		kind := ""
		switch {
		case e.custom != nil:
			kind = dimErr("custom")
		case e.webURL != "":
			kind = dimErr("web")
		}
		line := fmt.Sprintf("  %s  %s", dimErr(fmt.Sprintf("%d.", i+1)), cyanErr(e.label))
		if kind != "" {
			line += "  " + kind
		}
		note(line)
	}
	note("")
	return promptChoice(visible, "Tool", func(e launcherEntry) string { return e.label })
}
