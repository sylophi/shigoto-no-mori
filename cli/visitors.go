package main

// The villagers who have visited this device: every worktree named
// after a doubutsu character is that character moving in, and `sm
// create` counts it here, however the create was asked for (the app,
// a terminal, another device through its peer link). The app's
// Visitors section reads the tally through `sm visitors --json`, from
// every device, and adds them up. A worktree's copy landed by a mirror
// or a transplant (`--no-visit`) is the same visit, already counted
// where it began.
//
// The tally lives in visits.json in the data dir, one key:
//   villagers: { <slug>: { count, first, last } }
// with first and last in epoch milliseconds. A data dir that has never
// had a tally starts one at its first create, from the
// villagers living there at the time, so the residents from before the
// tally existed count once each. A read before then shows the same.

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	visitsFile   = "visits.json"
	villagersKey = "villagers"
)

func visitsPath() string { return filepath.Join(dataDir(), visitsFile) }

type villagerVisits struct {
	Count int   `json:"count"`
	First int64 `json:"first"`
	Last  int64 `json:"last"`
}

var doubutsuNameSet = sync.OnceValue(func() map[string]bool {
	set := map[string]bool{}
	for _, name := range doubutsuNames() {
		set[name] = true
	}
	return set
})

var numberedName = regexp.MustCompile(`^(.+)-\d+$`)

// The character a worktree is named after: its name, or its name
// before a numeric suffix (`sheldon-2`, a second Sheldon worktree), or
// "" for any other name. Matches speakerSlug in the app's
// renderer/lib/villagerVoice.ts.
func visitorSlug(name string) string {
	if doubutsuNameSet()[name] {
		return name
	}
	if m := numberedName.FindStringSubmatch(name); m != nil && doubutsuNameSet()[m[1]] {
		return m[1]
	}
	return ""
}

// One more visit, at `at`. The seed adds them in any order.
func (v villagerVisits) plus(at int64) villagerVisits {
	if v.Count == 0 {
		v.First, v.Last = at, at
	}
	v.First = min(v.First, at)
	v.Last = max(v.Last, at)
	v.Count++
	return v
}

// The tally a data dir starts from: one visit for every villager's
// home in the projects, at the time it was made where git still knows
// it.
func seedVisits(projects []project, now int64) map[string]villagerVisits {
	tally := map[string]villagerVisits{}
	for _, proj := range projects {
		identities, err := listWorktreeIdentities(proj)
		if err != nil {
			continue
		}
		for _, id := range identities {
			slug := visitorSlug(id.Name)
			if id.IsPrimary || slug == "" {
				continue
			}
			at := now
			if created := worktreeCreatedAt(id); created > 0 {
				at = created
			}
			tally[slug] = tally[slug].plus(at)
		}
	}
	return tally
}

// The tally as stored, or, when the data dir has none, one started
// from its residents (seeded).
func loadTally(raw json.RawMessage, projects []project, now int64) (tally map[string]villagerVisits, seeded bool, err error) {
	if raw == nil {
		return seedVisits(projects, now), true, nil
	}
	if err = decodeKey(visitsPath(), villagersKey, raw, &tally); err != nil {
		return nil, false, err
	}
	if tally == nil {
		tally = map[string]villagerVisits{}
	}
	return tally, false, nil
}

// Reads the tally, or, when the data dir has none yet, the one it will
// start from. A read never writes: the first create keeps the tally
// (recordVisit), so a peer reading this device changes nothing here.
func readVisits(projects []project) (map[string]villagerVisits, error) {
	all, err := readJSONObject(visitsPath())
	if err != nil {
		return nil, err
	}
	tally, _, err := loadTally(all[villagersKey], projects, time.Now().UnixMilli())
	return tally, err
}

// Counts a new worktree's villager in. A data dir without a tally
// starts one, which finds the new worktree among the rest. Best
// effort: a tally that can't be written never fails the create.
func recordVisit(projects []project, worktreeName string) {
	slug := visitorSlug(worktreeName)
	if slug == "" {
		return
	}
	err := updateFileKey(visitsPath(), villagersKey, func(raw json.RawMessage) (any, error) {
		now := time.Now().UnixMilli()
		tally, seeded, err := loadTally(raw, projects, now)
		if err != nil {
			return nil, err
		}
		if !seeded {
			tally[slug] = tally[slug].plus(now)
		}
		return tally, nil
	})
	if err != nil {
		vlog("[visitors] tally %s: %v", slug, err)
	}
}

// sm visitors: who has visited this device and how often, most visits
// first. App plumbing (the Visitors section reads --json), and a small
// treat in a terminal.
func cmdVisitors(ctx cliContext, args []string) (int, error) {
	if _, err := parseCmdArgs(args, argSpec{}); err != nil {
		return exitCodeOf(err), err
	}
	tally, err := readVisits(ctx.projects)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{villagersKey: tally})
		return 0, nil
	}
	if len(tally) == 0 {
		out(dimOut("No villagers have visited yet."))
		return 0, nil
	}
	slugs := make([]string, 0, len(tally))
	for slug := range tally {
		slugs = append(slugs, slug)
	}
	slices.SortFunc(slugs, func(a, b string) int {
		if d := tally[b].Count - tally[a].Count; d != 0 {
			return d
		}
		return strings.Compare(a, b)
	})
	rows := make([][]string, 0, len(slugs))
	for _, slug := range slugs {
		visits := tally[slug]
		times := fmt.Sprintf("%d %s", visits.Count, pluralize(visits.Count, "visit", "visits"))
		rows = append(rows, []string{cyanOut(slug), times,
			dimOut("last " + time.UnixMilli(visits.Last).Format("Jan 2, 2006"))})
	}
	for _, line := range alignRows(rows) {
		out(line)
	}
	return 0, nil
}
