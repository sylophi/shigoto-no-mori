package main

import (
	"encoding/json"
	"testing"
	"time"
)

func strp(s string) *string { return &s }

func TestSameCommit(t *testing.T) {
	cases := []struct {
		seen     string
		recorded *string
		want     bool
	}{
		{"abc1234", strp("abc1234"), true},
		// Git lengthened the abbreviation since the snapshot, or the
		// other way round.
		{"abc12345", strp("abc1234"), true},
		{"abc1234", strp("abc12345"), true},
		{"abc1234", strp("def5678"), false},
		// A head the snapshot couldn't read is unknown, not different.
		{"abc1234", nil, true},
	}
	for _, c := range cases {
		if got := sameCommit(c.seen, c.recorded); got != c.want {
			t.Errorf("sameCommit(%q, %v) = %v, want %v", c.seen, c.recorded, got, c.want)
		}
	}
}

func TestShelfWorked(t *testing.T) {
	snapshot := shelfSnapshot{At: 1000, Head: strp("abc1234"), Changed: 2}
	still := shelfObservation{at: 2000, head: "abc1234", changed: 2, lastChangeAt: 900}
	cases := []struct {
		name string
		seen func(shelfObservation) shelfObservation
		want bool
	}{
		{"nothing moved", func(s shelfObservation) shelfObservation { return s }, false},
		{"a commit", func(s shelfObservation) shelfObservation { s.head = "def5678"; return s }, true},
		{"a fast-forward it follows", func(s shelfObservation) shelfObservation {
			s.head, s.followsUpstream = "def5678", true
			return s
		}, false},
		{"no head read", func(s shelfObservation) shelfObservation { s.head = ""; return s }, false},
		{"a new changed path", func(s shelfObservation) shelfObservation { s.changed = 3; return s }, true},
		{"a path no longer changed", func(s shelfObservation) shelfObservation { s.changed = 1; return s }, true},
		{"a newer edit to a changed path", func(s shelfObservation) shelfObservation { s.lastChangeAt = 1001; return s }, true},
		{"an edit as old as the snapshot", func(s shelfObservation) shelfObservation { s.lastChangeAt = 1000; return s }, false},
	}
	for _, c := range cases {
		if got := shelfWorked(snapshot, c.seen(still)); got != c.want {
			t.Errorf("%s: worked = %v, want %v", c.name, got, c.want)
		}
	}
	headless := shelfSnapshot{At: 1000, Head: nil, Changed: 0}
	if shelfWorked(headless, shelfObservation{at: 2000, head: "abc1234"}) {
		t.Error("a snapshot without a head read a head as work")
	}
}

func TestParseShelfSnapshot(t *testing.T) {
	good := map[string]shelfSnapshot{
		`{"at":1758000000000,"head":"abc1234","changed":3}`: {At: 1758000000000, Head: strp("abc1234"), Changed: 3},
		`{"at":5,"head":null,"changed":0}`:                  {At: 5, Changed: 0},
	}
	for raw, want := range good {
		got, ok := parseShelfSnapshot(json.RawMessage(raw))
		if !ok || got.At != want.At || got.Changed != want.Changed || (got.Head == nil) != (want.Head == nil) ||
			(got.Head != nil && *got.Head != *want.Head) {
			t.Errorf("parse %s = %+v, %v; want %+v", raw, got, ok, want)
		}
	}
	for _, raw := range []string{
		`true`, `{}`, `{"at":1,"changed":0}`, `{"at":1,"head":7,"changed":0}`,
		`{"at":"1","head":null,"changed":0}`, `{"head":null,"changed":0}`, `{"at":1,"head":null}`,
	} {
		if _, ok := parseShelfSnapshot(json.RawMessage(raw)); ok {
			t.Errorf("parse %s: ok, want it read as absent", raw)
		}
	}
	// The written shape is the one the app wrote before the CLI took the
	// listing over.
	encoded, _ := json.Marshal(shelfObservation{at: 7, changed: 1}.snapshot())
	if string(encoded) != `{"at":7,"head":null,"changed":1}` {
		t.Errorf("encoded %s", encoded)
	}
}

// The listing-side writes, against a sandbox registry with synthetic
// rows (the probes themselves are the proof's, app/test/shelf.mts).
func TestSettleShelves(t *testing.T) {
	sandboxDataDir(t)
	row := func(id string) worktreeJSON {
		return worktreeJSON{ID: id, Shelved: true, ChangedCount: 1, LastChangeAt: 500,
			RecentCommits: []commitSummary{{Hash: "abc1234"}}}
	}
	ok := rowProbe{at: 1000, statusOK: true}
	contextNow := func() buildContext {
		all, err := readRegistryFile()
		if err != nil {
			t.Fatal(err)
		}
		return buildContext{shelfSnapshots: shelfSnapshotsFrom(all)}
	}
	snapshotOf := func(id string) (shelfSnapshot, bool) {
		var m map[string]json.RawMessage
		_ = json.Unmarshal(readFile(t, registryPath())[shelfSnapshotsKey], &m)
		return parseShelfSnapshot(m[id])
	}

	// First sighting seeds; a malformed entry is replaced; a failed
	// status and an unmarked id are left alone.
	seedRegistry(t, `{"shelvedWorktrees":{"w1":true,"w2":true,"w3":true},"shelfSnapshots":{"w2":{"at":"bad"}}}`)
	rows := []worktreeJSON{row("w1"), row("w2"), row("w3"), row("gone")}
	settleShelves(rows, []rowProbe{ok, ok, {at: 1000}, ok}, contextNow(), idleShelf{})
	for _, id := range []string{"w1", "w2"} {
		got, found := snapshotOf(id)
		if !found || got.At != 1000 || got.Changed != 1 || got.Head == nil || *got.Head != "abc1234" {
			t.Errorf("%s: snapshot %+v, %v; want the listing's", id, got, found)
		}
	}
	if _, found := snapshotOf("w3"); found {
		t.Error("w3: a failed status took a snapshot")
	}
	if _, found := snapshotOf("gone"); found {
		t.Error("an unmarked id took a snapshot")
	}
	for _, r := range rows {
		if !r.Shelved {
			t.Errorf("%s: unshelved on its first sighting", r.ID)
		}
	}

	// Nothing moved: stays shelved.
	rows = []worktreeJSON{row("w1")}
	settleShelves(rows, []rowProbe{{at: 2000, statusOK: true}}, contextNow(), idleShelf{})
	if !rows[0].Shelved || !readShelvedSet()["w1"] {
		t.Fatal("w1 unshelved with nothing moved")
	}

	// A listing that read w1's snapshot before a reshelve (which
	// retired it, and a later listing seeded a new one) leaves the
	// reshelve alone.
	stale := contextNow()
	if err := setShelved("w1", false); err != nil {
		t.Fatal(err)
	}
	if err := setShelved("w1", true); err != nil {
		t.Fatal(err)
	}
	settleShelves([]worktreeJSON{row("w1")}, []rowProbe{{at: 3000, statusOK: true}}, contextNow(), idleShelf{})
	fresh, _ := snapshotOf("w1")
	rows = []worktreeJSON{row("w1")}
	rows[0].ChangedCount = 5
	settleShelves(rows, []rowProbe{{at: 4000, statusOK: true}}, stale, idleShelf{})
	if !rows[0].Shelved || !readShelvedSet()["w1"] {
		t.Error("a stale listing undid the reshelve")
	}
	if got, _ := snapshotOf("w1"); got.At != fresh.At {
		t.Errorf("the reshelve's snapshot changed: %+v, want at %d", got, fresh.At)
	}

	// Worked in: the mark and the snapshot go, the row says so.
	rows = []worktreeJSON{row("w1"), row("w2")}
	rows[0].RecentCommits = []commitSummary{{Hash: "def5678"}}
	settleShelves(rows, []rowProbe{{at: 5000, statusOK: true}, {at: 5000, statusOK: true}}, contextNow(), idleShelf{})
	if rows[0].Shelved || readShelvedSet()["w1"] {
		t.Error("w1: a commit didn't unshelve it")
	}
	if _, found := snapshotOf("w1"); found {
		t.Error("w1: the snapshot survived the unshelve")
	}
	if !rows[1].Shelved || !readShelvedSet()["w2"] {
		t.Error("w2 went with w1")
	}
}

// The idle shelf, against a sandbox registry with synthetic rows: a
// managed row untouched for longer than the setting goes on the shelf
// with its snapshot, and anything newer, unmanaged or unread stays.
func TestSettleShelvesIdle(t *testing.T) {
	sandboxDataDir(t)
	const day = int64(24 * time.Hour / time.Millisecond)
	now := 100 * day
	probe := rowProbe{at: now, statusOK: true}
	dir := t.TempDir()
	row := func(id string, touched int64) worktreeJSON {
		return worktreeJSON{ID: id, Path: dir, CreatedAt: touched}
	}
	idleNow := func() idleShelf {
		all, err := readRegistryFile()
		if err != nil {
			t.Fatal(err)
		}
		return idleShelf{after: 7 * 24 * time.Hour, unshelvedAt: unshelvedAtFrom(all)}
	}
	seedRegistry(t, `{}`)

	old := now - 8*day
	committed := row("committed", old)
	committed.RecentCommits = []commitSummary{{Hash: "abc1234", Date: time.UnixMilli(now - day).Format(time.RFC3339)}}
	edited := row("edited", old)
	edited.LastChangeAt = now - day
	agent := row("agent", old)
	agent.AgentSessions = []agentSession{{State: agentIdle, At: now - day}}
	waiting := row("waiting", old)
	waiting.AgentSessions = []agentSession{{State: agentWaiting, At: old}}
	primary := row("primary", old)
	primary.IsPrimary = true
	external := row("external", old)
	external.IsExternal = true
	// A pull it only follows isn't a touch.
	pulled := row("pulled", old)
	pulled.AutoPull = true
	pulled.RecentCommits = committed.RecentCommits
	rows := []worktreeJSON{
		row("idle", old), pulled, row("fresh", now-6*day), row("unknown", 0),
		committed, edited, agent, waiting, primary, external, row("unread", old),
	}
	probes := make([]rowProbe, len(rows))
	for i := range probes {
		probes[i] = probe
	}
	probes[len(rows)-1] = rowProbe{at: now}
	settleShelves(rows, probes, buildContext{}, idleNow())
	shelved := readShelvedSet()
	for _, r := range rows {
		want := r.ID == "idle" || r.ID == "pulled"
		if r.Shelved != want || shelved[r.ID] != want {
			t.Errorf("%s: shelved row %v, mark %v; want %v", r.ID, r.Shelved, shelved[r.ID], want)
		}
	}
	var snapshots map[string]json.RawMessage
	_ = json.Unmarshal(readFile(t, registryPath())[shelfSnapshotsKey], &snapshots)
	if got, ok := parseShelfSnapshot(snapshots["idle"]); !ok || got.At != now {
		t.Errorf("idle: snapshot %+v, %v; want the listing's", got, ok)
	}

	// Unshelved by hand: the unshelve is a touch, so it stays off.
	if err := setShelved("idle", false); err != nil {
		t.Fatal(err)
	}
	rows = []worktreeJSON{row("idle", old)}
	settleShelves(rows, []rowProbe{{at: time.Now().UnixMilli(), statusOK: true}}, buildContext{}, idleNow())
	if rows[0].Shelved || readShelvedSet()["idle"] {
		t.Error("idle: shelved again right after an unshelve")
	}

	// A listing that read the registry before an unshelve doesn't shelve
	// over it.
	if err := setShelved("stale", true); err != nil {
		t.Fatal(err)
	}
	if err := setShelved("stale", false); err != nil {
		t.Fatal(err)
	}
	stale := idleNow()
	stale.unshelvedAt = nil
	rows = []worktreeJSON{row("stale", old)}
	settleShelves(rows, []rowProbe{probe}, buildContext{}, stale)
	if rows[0].Shelved || readShelvedSet()["stale"] {
		t.Error("stale: a stale listing shelved over the unshelve")
	}

	// Unshelved by work: that counts as a touch too.
	worked := row("idle", old)
	worked.Shelved = true
	worked.ChangedCount = 1
	if err := setShelved("idle", true); err != nil {
		t.Fatal(err)
	}
	rows = []worktreeJSON{row("idle", old)}
	rows[0].Shelved = true
	settleShelves(rows, []rowProbe{{at: now, statusOK: true}}, buildContext{}, idleShelf{})
	all, err := readRegistryFile()
	if err != nil {
		t.Fatal(err)
	}
	rows = []worktreeJSON{worked}
	settleShelves(rows, []rowProbe{{at: now, statusOK: true}}, buildContext{shelfSnapshots: shelfSnapshotsFrom(all)}, idleShelf{})
	if rows[0].Shelved || readShelvedSet()["idle"] {
		t.Fatal("idle: work didn't unshelve it")
	}
	rows = []worktreeJSON{row("idle", old)}
	settleShelves(rows, []rowProbe{{at: time.Now().UnixMilli(), statusOK: true}}, buildContext{}, idleNow())
	if rows[0].Shelved || readShelvedSet()["idle"] {
		t.Error("idle: shelved again right after work unshelved it")
	}

	// Off: nothing goes on the shelf.
	rows = []worktreeJSON{row("off", old)}
	settleShelves(rows, []rowProbe{probe}, buildContext{}, idleShelf{})
	if rows[0].Shelved || readShelvedSet()["off"] {
		t.Error("off: shelved with the setting off")
	}
}
