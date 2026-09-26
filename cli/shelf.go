package main

// A shelved worktree comes back off the shelf on its own once it is
// worked in: an edit, a new or deleted file, or a commit. Changes it
// was shelved with don't count, and neither does an auto-pull
// fast-forward.
//
// The full listing (`sm worktrees list`, and its --worktree-id form)
// already probes every row's HEAD and uncommitted changes, so the
// check costs no git of its own: the first listing that sees a
// worktree shelved records a snapshot of it under shelfSnapshotsKey,
// and a later listing that finds it moved past that snapshot unshelves
// it. The app lists through the CLI, so commits show up within its git
// watcher's debounce (it relists on every ref move), edits on the next
// focus or background refresh. The cheap --identities form runs no
// probes and so never settles anything.
//
// The snapshot's JSON shape is the one the app wrote before the CLI
// took the listing over, so a registry.json from that release reads
// as is.

import (
	"encoding/json"
	"strings"
)

// A shelved worktree as the first listing after the shelve saw it.
// Head is nil when the log came back empty: no commits yet, or a
// failed read.
type shelfSnapshot struct {
	At      int64   `json:"at"`
	Head    *string `json:"head"`
	Changed int     `json:"changed"`
}

// An entry that doesn't parse reads as absent, and the next listing
// replaces it with a fresh snapshot. All three fields must be there,
// head as a string or null.
func parseShelfSnapshot(raw json.RawMessage) (shelfSnapshot, bool) {
	if raw == nil {
		return shelfSnapshot{}, false
	}
	var wire struct {
		At      *int64          `json:"at"`
		Head    json.RawMessage `json:"head"`
		Changed *int            `json:"changed"`
	}
	if json.Unmarshal(raw, &wire) != nil || wire.At == nil || wire.Changed == nil || wire.Head == nil {
		return shelfSnapshot{}, false
	}
	var head *string
	if json.Unmarshal(wire.Head, &head) != nil {
		return shelfSnapshot{}, false
	}
	return shelfSnapshot{At: *wire.At, Head: head, Changed: *wire.Changed}, true
}

// The snapshots that parse, from one registry read.
func shelfSnapshotsFrom(all map[string]json.RawMessage) map[string]shelfSnapshot {
	raw := map[string]json.RawMessage{}
	if err := decodeKey(registryPath(), shelfSnapshotsKey, all[shelfSnapshotsKey], &raw); err != nil {
		vlog("[shelf] %v", err)
		return nil
	}
	snapshots := make(map[string]shelfSnapshot, len(raw))
	for id, entry := range raw {
		if snapshot, ok := parseShelfSnapshot(entry); ok {
			snapshots[id] = snapshot
		}
	}
	return snapshots
}

// What one listing saw of a shelved worktree.
type shelfObservation struct {
	// When the row's probes started, epoch ms: a snapshot taken from
	// them covers every change older than this.
	at int64
	// The newest commit's abbreviated hash, "" when there is none (or
	// the log failed).
	head    string
	changed int
	// Newest mtime among the changed paths, 0 when none was read.
	lastChangeAt int64
	// An auto-pull worktree with nothing unpushed: the app fast-forwards
	// it on its own, so a HEAD move there is the pull and not the user.
	// A commit made here still shows as unpushed until it is pushed.
	followsUpstream bool
}

func (seen shelfObservation) snapshot() shelfSnapshot {
	snapshot := shelfSnapshot{At: seen.at, Changed: seen.changed}
	if seen.head != "" {
		head := seen.head
		snapshot.Head = &head
	}
	return snapshot
}

// Git lengthens abbreviated hashes as a repository grows, so the same
// commit can come back one character longer than it was recorded. A
// head the snapshot couldn't read compares as unknown: a first commit
// still shows in the changed count.
func sameCommit(seen string, recorded *string) bool {
	if recorded == nil {
		return true
	}
	return strings.HasPrefix(seen, *recorded) || strings.HasPrefix(*recorded, seen)
}

// Whether the worktree moved past its snapshot. The mtime check only
// sees the first paths getWorkingTreeChanges stats, so a new edit to
// one path in a very dirty tree can slip past it. The count still
// catches any path that becomes (or stops being) changed.
func shelfWorked(snapshot shelfSnapshot, seen shelfObservation) bool {
	return (seen.head != "" && !sameCommit(seen.head, snapshot.Head) && !seen.followsUpstream) ||
		seen.changed != snapshot.Changed ||
		seen.lastChangeAt > snapshot.At
}

// What a row's probes measured beyond the row itself.
type rowProbe struct {
	// Epoch ms when the probes started.
	at int64
	// Whether the status probe answered. A failed one shows as 0
	// changes on the row, which the shelf must not compare.
	statusOK bool
}

// Settles every shelved row of one listing against the snapshots its
// context read, in one registry write: a row without a snapshot gets
// one, and a row worked in since its snapshot comes back unshelved.
// A row whose status failed is left alone. A failed write leaves every
// row shelved: the next listing tries again.
func settleShelves(rows []worktreeJSON, probes []rowProbe, ctx buildContext) {
	seeds := map[string]shelfSnapshot{}
	retires := map[string]int64{}
	for i, row := range rows {
		if !row.Shelved || !probes[i].statusOK {
			continue
		}
		seen := shelfObservation{
			at:              probes[i].at,
			changed:         row.ChangedCount,
			lastChangeAt:    row.LastChangeAt,
			followsUpstream: row.AutoPull && row.UnpushedCount == 0,
		}
		if len(row.RecentCommits) > 0 {
			seen.head = row.RecentCommits[0].Hash
		}
		snapshot, ok := ctx.shelfSnapshots[row.ID]
		switch {
		case !ok:
			seeds[row.ID] = seen.snapshot()
		case shelfWorked(snapshot, seen):
			retires[row.ID] = snapshot.At
		}
	}
	if len(seeds) == 0 && len(retires) == 0 {
		return
	}
	unshelved, err := writeShelfSettlement(seeds, retires)
	if err != nil {
		vlog("[shelf] could not update the shelf: %v", err)
		return
	}
	for i := range rows {
		if unshelved[rows[i].ID] {
			rows[i].Shelved = false
		}
	}
}

// The listing read the registry before its probes and acts on it
// after, so both kinds of write check the entry again under the lock:
// a shelve or unshelve in between (which retires the snapshot) wins
// over the listing's stale view. A seed lands only while the worktree
// is still marked and has no snapshot that parses; a retire only while
// the snapshot on file is still the one the listing compared against.
// Answers the ids it unshelved.
func writeShelfSettlement(seeds map[string]shelfSnapshot, retires map[string]int64) (map[string]bool, error) {
	unshelved := map[string]bool{}
	err := updateShelf(func(marks map[string]bool, snapshots map[string]json.RawMessage) (bool, error) {
		changed := false
		for id, snapshot := range seeds {
			if _, taken := parseShelfSnapshot(snapshots[id]); taken || !marks[id] {
				continue
			}
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				return false, err
			}
			snapshots[id] = encoded
			changed = true
		}
		for id, at := range retires {
			if stored, ok := parseShelfSnapshot(snapshots[id]); !ok || stored.At != at {
				continue
			}
			delete(snapshots, id)
			delete(marks, id)
			unshelved[id] = true
			changed = true
		}
		return changed, nil
	})
	if err != nil {
		return nil, err
	}
	return unshelved, nil
}
