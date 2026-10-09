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
// The same listings keep the idle shelf: with the autoShelveDays
// setting on, a managed worktree nothing has touched for that many
// days goes on the shelf, its snapshot taken in the same write. A
// touch is a commit or other move of HEAD, an edit, an agent session
// changing state, the worktree's creation, or an unshelve, by hand or
// by work. A pull into an auto-pull worktree isn't one, as above.
//
// The snapshot's JSON shape is the one the app wrote before the CLI
// took the listing over, so a registry.json from that release reads
// as is.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
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

// What the idle shelf works from, read only where a listing settles
// the shelf: how long a worktree may go untouched, 0 while the
// autoShelveDays setting is off, and the unshelve times it counts as
// touches.
type idleShelf struct {
	after       time.Duration
	unshelvedAt map[string]int64
}

// Past a century the count means never, and a duration can't hold
// much more.
const maxIdleShelfDays = 36500

func loadIdleShelf() idleShelf {
	days := readGlobalConfigHints().AutoShelveDays
	if days == nil || *days <= 0 {
		return idleShelf{}
	}
	return idleShelf{
		after:       time.Duration(min(*days, maxIdleShelfDays)) * 24 * time.Hour,
		unshelvedAt: unshelvedAtFrom(readRegistryHints()),
	}
}

// The unshelve times, from one registry read.
func unshelvedAtFrom(all map[string]json.RawMessage) map[string]int64 {
	times := map[string]int64{}
	if err := decodeKey(registryPath(), unshelvedAtKey, all[unshelvedAtKey], &times); err != nil {
		vlog("[shelf] %v", err)
		return nil
	}
	return times
}

// The newest touch the row shows (the app's worktreeLastActivityAt,
// plus its creation), HEAD's last move, or the unshelve, epoch ms. 0
// when nothing is known. A commit's own date can be old (a rebase or a
// checkout keeps it), so HEAD's reflog stands in for the move itself.
// Neither counts where HEAD only follows its upstream.
func lastTouchedAt(row worktreeJSON, unshelvedAt int64) int64 {
	touched := max(row.LastChangeAt, row.CreatedAt, unshelvedAt)
	if !(row.AutoPull && row.UnpushedCount == 0) {
		if len(row.RecentCommits) > 0 {
			if committed, err := time.Parse(time.RFC3339, row.RecentCommits[0].Date); err == nil {
				touched = max(touched, committed.UnixMilli())
			}
		}
		touched = max(touched, headMovedAt(row.Path))
	}
	for _, session := range row.AgentSessions {
		touched = max(touched, session.At)
	}
	return touched
}

// When HEAD last moved in a linked worktree, epoch ms: the mtime of its
// admin dir's HEAD reflog, which every commit, checkout, rebase and
// reset appends to. 0 when there is none to read.
func headMovedAt(worktreePath string) int64 {
	adminDir := worktreeAdminDir(worktreePath)
	if adminDir == "" {
		return 0
	}
	info, err := os.Stat(filepath.Join(adminDir, "logs", "HEAD"))
	if err != nil {
		return 0
	}
	return max(info.ModTime().UnixMilli(), 0)
}

// Whether the idle shelf takes an unshelved row probed at `at`: a
// managed worktree whose newest touch is older than the setting
// allows. One with no touch known is left out, and so is one with an
// agent session mid-turn, whose time is when the turn started (or
// when it began waiting on the user).
func (idle idleShelf) takes(row worktreeJSON, at int64) bool {
	if idle.after == 0 || !shelfable(identityOf(row)) || anyActive(row.AgentSessions) {
		return false
	}
	touched := lastTouchedAt(row, idle.unshelvedAt[row.ID])
	return touched > 0 && touched < at-idle.after.Milliseconds()
}

// Settles every row of one listing against the shelf its context
// read, in one registry write: a shelved row without a snapshot gets
// one, a shelved row worked in since its snapshot comes back
// unshelved, and a row the idle shelf takes goes on the shelf with
// its snapshot. A row whose status failed is left alone. A failed
// write changes no row: the next listing tries again.
func settleShelves(rows []worktreeJSON, probes []rowProbe, ctx buildContext, idle idleShelf) {
	seeds := map[string]shelfSnapshot{}
	retires := map[string]int64{}
	shelves := map[string]bool{}
	for i, row := range rows {
		if !probes[i].statusOK {
			continue
		}
		seen := observe(row, probes[i])
		if !row.Shelved {
			if idle.takes(row, seen.at) {
				seeds[row.ID] = seen.snapshot()
				shelves[row.ID] = true
			}
			continue
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
	flipped, err := writeShelfSettlement(seeds, retires, shelves, idle.unshelvedAt)
	if err != nil {
		vlog("[shelf] could not update the shelf: %v", err)
		return
	}
	for i := range rows {
		if shelved, ok := flipped[rows[i].ID]; ok {
			rows[i].Shelved = shelved
		}
	}
}

func observe(row worktreeJSON, probe rowProbe) shelfObservation {
	seen := shelfObservation{
		at:              probe.at,
		changed:         row.ChangedCount,
		lastChangeAt:    row.LastChangeAt,
		followsUpstream: row.AutoPull && row.UnpushedCount == 0,
	}
	if len(row.RecentCommits) > 0 {
		seen.head = row.RecentCommits[0].Hash
	}
	return seen
}

// The listing read the registry before its probes and acts on it
// after, so every kind of write checks the entry again under the lock:
// a shelve or unshelve in between (which retires the snapshot) wins
// over the listing's stale view. An idle shelve lands only while the
// worktree is still unmarked and hasn't been unshelved since the
// listing read unshelvedAt, and then seeds like any shelved row (a
// shelve that doesn't land drops its seed: a shelve by hand in between
// waits for a fresh one). A seed lands only while the worktree is
// marked and has no snapshot that parses. A retire lands only while
// the snapshot on file is still the one the listing compared against,
// and it counts as an unshelve. Answers each row it flipped, with its new
// shelved state.
func writeShelfSettlement(seeds map[string]shelfSnapshot, retires map[string]int64, shelves map[string]bool, unshelvedAt map[string]int64) (map[string]bool, error) {
	flipped := map[string]bool{}
	err := updateShelf(func(shelf shelfState) (bool, error) {
		changed := false
		for id := range shelves {
			if shelf.marks[id] || shelf.unshelvedAt[id] != unshelvedAt[id] {
				delete(seeds, id)
				continue
			}
			shelf.marks[id] = true
			delete(shelf.unshelvedAt, id)
			flipped[id] = true
			changed = true
		}
		for id, snapshot := range seeds {
			if _, taken := parseShelfSnapshot(shelf.snapshots[id]); taken || !shelf.marks[id] {
				continue
			}
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				return false, err
			}
			shelf.snapshots[id] = encoded
			changed = true
		}
		for id, at := range retires {
			if stored, ok := parseShelfSnapshot(shelf.snapshots[id]); !ok || stored.At != at {
				continue
			}
			delete(shelf.snapshots, id)
			delete(shelf.marks, id)
			shelf.unshelvedAt[id] = time.Now().UnixMilli()
			flipped[id] = false
			changed = true
		}
		return changed, nil
	})
	if err != nil {
		return nil, err
	}
	return flipped, nil
}
