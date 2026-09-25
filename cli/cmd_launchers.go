package main

// sm launchers [list] [-p <project>]: a project's launcher row, the
// same list `sm open` picks from and in the app's order (recent use,
// then label), with hidden launchers left out. --json is the document
// the app's launcher row renders (its launchers:forProject result:
// entries + hiddenCount), plus each shown entry's use stats.

import (
	"fmt"
	"slices"
	"strconv"
	"time"
)

// One launcher-row entry, the app's LauncherEntrySchema
// (shared/schemas/launchers.ts): kind "detected" carries available
// (always true here, since only installed tools are listed), "custom"
// and "web" don't.
type launcherEntryJSON struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available *bool  `json:"available,omitempty"`
}

func (e launcherEntry) kind() string {
	switch {
	case e.custom != nil:
		return "custom"
	case e.webURL != "":
		return "web"
	}
	return "detected"
}

func cmdLaunchers(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}, "project-id": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if sub := parsed.positional(0); sub != "" && sub != "list" && sub != "ls" {
		return 2, usageErrf("Unknown subcommand %q. Usage: %s launchers [list] [-p <project>]", sub, binaryName)
	}
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}

	all := availableLaunchers(proj)
	hidden := map[string]bool{}
	for _, id := range readGlobalConfigHints().HiddenLaunchers {
		hidden[id] = true
	}
	shown := slices.DeleteFunc(slices.Clone(all), func(e launcherEntry) bool { return hidden[e.id] })
	sortLaunchersByUse(shown)
	useLog := readStateHintKey[map[string][]int64]("launcherUseLog")
	now := time.Now()

	if jsonMode {
		available := true
		entries := make([]launcherEntryJSON, len(shown))
		usage := make(map[string]useStat, len(shown))
		for i, e := range shown {
			entries[i] = launcherEntryJSON{Kind: e.kind(), ID: e.id, Label: e.label}
			if e.app != nil {
				entries[i].Available = &available
			}
			usage[e.id] = useStatOf(useLog[e.id], now)
		}
		emit(map[string]any{
			"ok": true, "entries": entries,
			"hiddenCount": len(all) - len(shown), "usage": usage,
		})
		return 0, nil
	}
	if len(shown) == 0 {
		note("No launchers available for " + proj.Name + ".")
		return 0, nil
	}
	rows := make([][]string, len(shown))
	for i, e := range shown {
		uses := useStatOf(useLog[e.id], now).RecentCount
		rows[i] = []string{e.label, dimOut(e.id), strconv.Itoa(uses)}
	}
	out(renderTable([]string{"LAUNCHER", "ID", "USES (14d)"}, rows))
	if n := len(all) - len(shown); n > 0 {
		note(dimErr(fmt.Sprintf("%d hidden", n)))
	}
	return 0, nil
}
