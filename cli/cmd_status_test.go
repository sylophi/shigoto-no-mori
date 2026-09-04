package main

// Tests for the status card's pure pieces: porcelain classification,
// the port-pool env reverse lookup, the gh check rollup, and the age /
// truncation formatting. Everything here is string in, string out --
// no repo, no data dir, no gh.

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestChangeCountsSplitIndexAndWorktree(t *testing.T) {
	porcelain := strings.Join([]string{
		"M  staged.go",   // index only
		" M unstaged.go", // worktree only
		"MM both.go",     // both sides
		"?? new.go",      // untracked
		"A  added.go",    // index only
		"R  new.go",      // rename, index only...
		"old.go",         // ...and the bare source field it emits
		"",
	}, "\x00")
	got := foldChangeCounts(parseStatusEntries(porcelain))
	want := changeCounts{Staged: 4, Unstaged: 2, Untracked: 1, Total: 6}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if got.clean() {
		t.Fatal("a dirty tree reported clean")
	}
}

func TestChangeCountsConflictsAreNotDoubleCounted(t *testing.T) {
	porcelain := "UU both.go\x00AA added.go\x00DD gone.go\x00DU half.go\x00M  fine.go\x00"
	got := foldChangeCounts(parseStatusEntries(porcelain))
	want := changeCounts{Staged: 1, Conflicted: 4, Total: 5}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestChangeCountsIgnoreIgnoredAndEmpty(t *testing.T) {
	got := foldChangeCounts(parseStatusEntries("!! node_modules/\x00\x00\x00"))
	if !got.clean() {
		t.Fatalf("expected clean, got %+v", got)
	}
}

func TestParseEnvAssignments(t *testing.T) {
	env := parseEnvAssignments(strings.Join([]string{
		"# port-pool",
		"PORT=4170",
		"export API_PORT = 4171",
		`QUOTED="4172"`,
		"NOEQUALS",
		"",
	}, "\n"))
	want := map[string]string{"PORT": "4170", "API_PORT": "4171", "QUOTED": "4172"}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("got %v, want %v", env, want)
	}
}

func TestMatchPortsReadsWholeValueTemplatesOnly(t *testing.T) {
	config := portPoolConfig{
		PortNames: []string{"renderer", "api", "unwritten"},
		EnvFiles: map[string]map[string]string{
			".env": {
				"PORT":     "${renderer}",
				"API_PORT": "${api}",
				"API_URL":  "http://localhost:${api}", // embedded, unreversible
				"NAME":     "static",
			},
		},
	}
	files := map[string]string{".env": "PORT=4170\nAPI_PORT=4171\nAPI_URL=http://localhost:4171\nNAME=static\n"}
	want := []portInfo{
		{Name: "api", Port: 4171, File: ".env", Key: "API_PORT"},
		{Name: "renderer", Port: 4170, File: ".env", Key: "PORT"},
	}
	if got := matchPorts(config, files); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMatchPortsSkipsMissingFilesAndNonNumbers(t *testing.T) {
	config := portPoolConfig{
		PortNames: []string{"renderer", "web"},
		EnvFiles: map[string]map[string]string{
			".env":     {"PORT": "${renderer}"},
			".env.web": {"WEB_PORT": "${web}"},
		},
	}
	// .env.web was never written; .env holds a placeholder, not a port.
	got := matchPorts(config, map[string]string{".env": "PORT=${renderer}\n"})
	if len(got) != 0 {
		t.Fatalf("expected no ports, got %+v", got)
	}
}

func TestMatchPortsIsStableAcrossFiles(t *testing.T) {
	config := portPoolConfig{
		PortNames: []string{"renderer"},
		EnvFiles: map[string]map[string]string{
			".env":       {"PORT": "${renderer}"},
			".env.local": {"PORT": "${renderer}"},
		},
	}
	files := map[string]string{".env": "PORT=4170\n", ".env.local": "PORT=4170\n"}
	for i := 0; i < 20; i++ {
		got := matchPorts(config, files)
		if len(got) != 1 || got[0].File != ".env" {
			t.Fatalf("run %d: got %+v", i, got)
		}
	}
}

func TestRollupChecks(t *testing.T) {
	nodes := []checkNode{
		{Status: "COMPLETED", Conclusion: "SUCCESS"},
		{Status: "COMPLETED", Conclusion: "SKIPPED"},
		{Status: "COMPLETED", Conclusion: "FAILURE"},
		{Status: "IN_PROGRESS"},
		{Status: "QUEUED", Conclusion: "SUCCESS"}, // not done: still pending
		{State: "SUCCESS"},                        // StatusContext
		{State: "ERROR"},
		{State: "PENDING"},
	}
	want := prChecks{Total: 8, Passing: 3, Failing: 2, Pending: 3}
	if got := rollupChecks(nodes); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if got := rollupChecks(nil); got.Total != 0 {
		t.Fatalf("nil rollup should be empty, got %+v", got)
	}
}

func TestGhProbeReasonNamesTheAuthFailure(t *testing.T) {
	auth := "gh: To get started with GitHub CLI, please run:  gh auth login\nAlso, ..."
	if got := ghProbeReason(auth); got != "gh isn't authenticated" {
		t.Fatalf("got %q", got)
	}
	if got := ghProbeReason("\n\n  could not resolve host\n"); got != "could not resolve host" {
		t.Fatalf("got %q", got)
	}
	if got := ghProbeReason(""); got != "gh failed" {
		t.Fatalf("got %q", got)
	}
	long := ghProbeReason(strings.Repeat("x", 200))
	if len([]rune(long)) != 60 {
		t.Fatalf("reason not clamped: %d runes", len([]rune(long)))
	}
}

func TestRelativeAge(t *testing.T) {
	now := time.Now()
	cases := []struct {
		at   time.Time
		want string
	}{
		{now.Add(-30 * time.Second), "just now"},
		{now.Add(-5 * time.Minute), "5m ago"},
		{now.Add(-3 * time.Hour), "3h ago"},
		{now.Add(-50 * time.Hour), "2d ago"},
		{now.Add(-21 * 24 * time.Hour), "3w ago"},
		{now.Add(-100 * 24 * time.Hour), "3mo ago"},
		{now.Add(-800 * 24 * time.Hour), "2y ago"},
	}
	for _, c := range cases {
		if got := relativeAge(c.at.Format(time.RFC3339)); got != c.want {
			t.Errorf("%s: got %q, want %q", c.at, got, c.want)
		}
	}
	if got := relativeAge("not a date"); got != "" {
		t.Errorf("unparseable date should be empty, got %q", got)
	}
	if got := relativeAge(""); got != "" {
		t.Errorf("missing date should be empty, got %q", got)
	}
}

func TestTruncateRunes(t *testing.T) {
	cases := []struct {
		in, want string
		max      int
	}{
		{"short", "short", 10},
		{"exactly-10", "exactly-10", 10},
		{"a longer subject line", "a longer …", 10},
		{"日本語のコミット", "日本語…", 4},
		{"anything", "anything", 1},
	}
	for _, c := range cases {
		if got := truncateRunes(c.in, c.max); got != c.want {
			t.Errorf("truncateRunes(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
}

// The card must render without color, without a PR, and without the
// optional rows -- the shape a piped `sm status` produces.
func TestStatusCardPlainRendersEveryKnownRow(t *testing.T) {
	status := statusJSON{
		ProjectName: "shigoto-no-mori",
		Name:        "bubbly-mouse",
		Branch:      "exp/cli-status",
		Path:        "/tmp/wt/bubbly-mouse",
		Shelved:     true,
		Git: gitStatusJSON{
			Upstream:     &syncJSON{Ahead: 2},
			Base:         &baseJSON{Ref: "origin/main", syncJSON: syncJSON{Behind: 7}},
			changeCounts: changeCounts{Staged: 1, Untracked: 3, Total: 4},
			StashCount:   2,
			LastCommit:   &commitSummary{Hash: "e158ef8", Subject: "Add the status card"},
		},
		Ports:         []portInfo{{Name: "renderer", Port: 4170}},
		Scripts:       scriptsJSON{Setup: "pnpm install"},
		PortPool:      portPoolJSON{Enabled: true, Installed: true, Configured: true},
		PRUnavailable: "gh isn't installed",
	}
	card := statusCard(status, "")
	for _, want := range []string{
		"shigoto-no-mori/bubbly-mouse", "(shelved)",
		"branch", "exp/cli-status", "↑2",
		"base", "origin/main", "↓7",
		"changes", "1 staged, 3 untracked",
		"stash", "2 (repo-wide)",
		"commit", "e158ef8", "Add the status card",
		"ports", "renderer 4170",
		"setup", "pnpm install",
		"pr", "unavailable (gh isn't installed)",
	} {
		if !strings.Contains(card, want) {
			t.Errorf("card is missing %q:\n%s", want, card)
		}
	}
	if strings.Contains(card, "teardown") {
		t.Errorf("unset teardown should have no row:\n%s", card)
	}
}

func TestOnBaseBranch(t *testing.T) {
	cases := []struct {
		branch, ref string
		want        bool
	}{
		{"main", "origin/main", true},
		{"main", "main", true},
		{"exp/cli-status", "origin/main", false},
		{"main", "origin/mainline", false},
		{"", "origin/main", false},
		{"main", "", false},
	}
	for _, c := range cases {
		if got := onBaseBranch(c.branch, c.ref); got != c.want {
			t.Errorf("onBaseBranch(%q, %q) = %v", c.branch, c.ref, got)
		}
	}
}

func TestPRLine(t *testing.T) {
	open := &prCard{prSummary: prSummary{Number: 146, Title: "Add the status card", State: "OPEN"}}
	if got := prLine(open, 40); got != "#146 open  Add the status card" {
		t.Errorf("got %q", got)
	}
	draft := &prCard{prSummary: prSummary{Number: 7, Title: "WIP", State: "OPEN", IsDraft: true}}
	if got := prLine(draft, 40); !strings.Contains(got, "draft") || strings.Contains(got, "open") {
		t.Errorf("a draft should read as draft: %q", got)
	}
	withChecks := &prCard{
		prSummary: prSummary{Number: 9, Title: "Long title that will not fit", State: "MERGED"},
		Checks:    &prChecks{Total: 6, Passing: 4, Failing: 1, Pending: 1},
	}
	got := prLine(withChecks, 12)
	for _, want := range []string{"#9", "merged", "Long title …", "1 failing", "1 pending", "4 passing"} {
		if !strings.Contains(got, want) {
			t.Errorf("pr line %q is missing %q", got, want)
		}
	}
	// The all-green case stays a single phrase rather than a list.
	green := prChecks{Total: 3, Passing: 3}
	if got := checksLine(green); got != "3 passing" {
		t.Errorf("got %q", got)
	}
}

func TestStatusCardSkipsThePRRowWhenAsked(t *testing.T) {
	status := statusJSON{ProjectName: "p", Name: "w", Branch: "b", Path: "/tmp/w"}
	skipped := status
	skipped.PRSkipped = true
	if card := statusCard(skipped, ""); strings.Contains(card, "pr ") {
		t.Fatalf("--no-pr should print no pr row:\n%s", card)
	}
	if card := statusCard(status, ""); !strings.Contains(card, "none") {
		t.Fatalf("a branch with no PR should say so:\n%s", card)
	}
}
