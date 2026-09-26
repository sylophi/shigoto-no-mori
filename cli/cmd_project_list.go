package main

// sm projects list --json and sm projects icon: the project rows the
// app's sidebar renders, built here so the app reads them instead of
// merging terrier, probing identity, counting usage and scanning for
// icons itself.

import (
	"encoding/base64"
	"os"
	"sync"
	"time"
)

// One project row: the app's ProjectSchema fields
// (shared/schemas/project.ts) plus the resolved icon and accent hue.
// The list is the pre-dispatch merge (main.go), so terrier-only repos
// are here with source "terrier", in the same order the app merges.
type projectRowJSON struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	// False when the path is gone from disk (deleted, moved, unmounted).
	PathExists bool `json:"pathExists"`
	// Repo identity (repoidentity.go), null when the repo has none or
	// the path is gone.
	Identity *string `json:"identity"`
	// Project use log (state.json projectUseLog): newest use, epoch ms
	// (0 = never), and uses within the rolling 14-day window. The app
	// records the uses; the CLI's own verbs don't count as one.
	LastUsed    int64 `json:"lastUsed"`
	RecentCount int   `json:"recentCount"`
	// The resolved icon file, null when the project has none.
	Icon *projectIconRef `json:"icon"`
	// OKLCH hue in degrees of the icon's dominant color, null when there
	// is no icon or it is monochrome.
	Hue *float64 `json:"hue"`
}

type projectIconRef struct {
	Path string `json:"path"`
	Mime string `json:"mime"`
}

// The app's ProjectIconSchema: the icon's bytes, ready for a data URL.
type projectIconBytes struct {
	Mime   string `json:"mime"`
	Base64 string `json:"base64"`
}

func buildProjectRows(projects []project, rescanIconMisses bool) []projectRowJSON {
	useLog := readStateHintKey[map[string][]int64]("projectUseLog")
	now := time.Now()
	rows := make([]projectRowJSON, len(projects))
	var wg sync.WaitGroup
	for i, p := range projects {
		wg.Go(func() {
			use := useStatOf(useLog[p.ID], now)
			row := projectRowJSON{
				ID: p.ID, Name: p.Name, Path: p.Path, Source: p.Source,
				LastUsed: use.LastUsed, RecentCount: use.RecentCount,
			}
			if info, err := os.Stat(p.Path); err == nil && info.IsDir() {
				row.PathExists = true
				if identity := repoIdentity(p.Path); identity != "" {
					row.Identity = &identity
				}
				if entry, ok := projectIcon(p, rescanIconMisses); ok {
					row.Icon = &projectIconRef{Path: entry.SourcePath, Mime: entry.Mime}
					if hue, ok := accentFrom(*entry.Hue); ok {
						row.Hue = &hue
					}
				}
			}
			rows[i] = row
		})
	}
	wg.Wait()
	flushIconCache()
	return rows
}

func cmdProjectList(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		// Re-scan projects the icon cache remembers as icon-less, so an
		// icon added since shows up (the app passes it on its first
		// list of a session).
		bools: map[string][]string{"refresh-icons": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(buildProjectRows(ctx.projects, parsed.bools["refresh-icons"]))
		return 0, nil
	}
	return printProjectTable(ctx.projects)
}

// sm projects icon [<name>]: the project's icon bytes as the app's
// ProjectIconSchema document ({mime, base64}), null when it has none.
// Resolution goes through the same cache as the list.
func cmdProjectIcon(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}, "project-id": {}},
		bools:   map[string][]string{"refresh-icons": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if ref := parsed.positional(0); ref != "" && parsed.strings["project"] == "" {
		parsed.strings["project"] = ref
	}
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	entry, ok := projectIcon(proj, parsed.bools["refresh-icons"])
	flushIconCache()
	var icon *projectIconBytes
	if ok {
		if data, err := os.ReadFile(entry.SourcePath); err == nil {
			icon = &projectIconBytes{Mime: entry.Mime, Base64: base64.StdEncoding.EncodeToString(data)}
		}
	}
	if jsonMode {
		emit(icon)
		return 0, nil
	}
	if icon == nil {
		note("No icon found for " + proj.Name + ".")
		return 0, nil
	}
	out(entry.SourcePath)
	return 0, nil
}
