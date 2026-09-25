package main

// The worktree rows the app parses (WorktreeSchema): autoPull and
// primaryBranch on every row-emitting verb, list's --project-id /
// --worktree-id plumbing, and the autopull verb. Against real git in a
// temp SHIGOMORI_DATA_DIR.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// Runs fn in --json mode and returns every NDJSON document it printed
// on stdout, decoded. The reader drains concurrently so a large emit
// can't fill the pipe and wedge fn.
func captureJSON(t *testing.T, fn func()) []json.RawMessage {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	savedOut, savedMode := os.Stdout, jsonMode
	os.Stdout, jsonMode = w, true
	done := make(chan []byte)
	go func() {
		data, _ := io.ReadAll(r)
		done <- data
	}()
	defer func() {
		os.Stdout, jsonMode = savedOut, savedMode
	}()
	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	data := <-done
	var docs []json.RawMessage
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		if line := bytes.TrimSpace(scanner.Bytes()); len(line) > 0 {
			docs = append(docs, json.RawMessage(bytes.Clone(line)))
		}
	}
	return docs
}

func decodeT[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return v
}

// The one document a single-document verb printed.
func onlyDoc(t *testing.T, docs []json.RawMessage) json.RawMessage {
	t.Helper()
	if len(docs) != 1 {
		t.Fatalf("got %d documents, want 1: %s", len(docs), docs)
	}
	return docs[0]
}

// A registered project whose primary ref resolves to a remote-tracking
// ref (origin/main), so primaryRef and primaryBranch differ.
func projectWithOrigin(t *testing.T) project {
	t.Helper()
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "repo")
	origin := filepath.Join(root, "origin.git")
	runGitT(t, root, "clone", "-q", "--bare", repo, origin)
	runGitT(t, repo, "remote", "add", "origin", origin)
	runGitT(t, repo, "fetch", "-q", "origin")
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	return proj
}

func TestListRowsCarryAutoPullAndPrimaryBranch(t *testing.T) {
	proj := projectWithOrigin(t)
	wt := createViaCmd(t, proj, "fox")
	if err := setRegistryMark(autoPullKey, worktreeIDFromPath(proj.Path), true); err != nil {
		t.Fatal(err)
	}

	// From outside any project, the way the app runs it.
	ctx := cliContext{projects: []project{proj}}
	docs := captureJSON(t, func() {
		if code, err := cmdList(ctx, []string{"--project-id", proj.ID}); code != 0 || err != nil {
			t.Fatalf("list: %d, %v", code, err)
		}
	})
	rows := decodeT[[]worktreeJSON](t, onlyDoc(t, docs))
	if len(rows) != 2 || !rows[0].IsPrimary {
		t.Fatalf("rows = %+v, want primary then fox", rows)
	}
	for _, row := range rows {
		if row.PrimaryRef != "origin/main" || row.PrimaryBranch != "main" {
			t.Errorf("%s: primaryRef %q primaryBranch %q, want origin/main and main", row.Name, row.PrimaryRef, row.PrimaryBranch)
		}
	}
	if !rows[0].AutoPull || rows[1].AutoPull {
		t.Errorf("autoPull = %v/%v, want the primary marked and fox not", rows[0].AutoPull, rows[1].AutoPull)
	}
	// The raw document spells the fields the schema reads.
	var raw []map[string]any
	if err := json.Unmarshal(onlyDoc(t, docs), &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw[1]["autoPull"]; !ok {
		t.Errorf("an unmarked row omits autoPull: %v", raw[1])
	}

	// -p takes the path or the id just as well, from outside.
	for _, ref := range []string{proj.Path, proj.ID} {
		docs := captureJSON(t, func() {
			if code, err := cmdList(ctx, []string{"-p", ref}); code != 0 || err != nil {
				t.Fatalf("list -p %s: %d, %v", ref, code, err)
			}
		})
		if got := decodeT[[]worktreeJSON](t, onlyDoc(t, docs)); len(got) != 2 {
			t.Errorf("list -p %s = %d rows, want 2", ref, len(got))
		}
	}

	// --worktree-id narrows it to one row.
	docs = captureJSON(t, func() {
		if code, err := cmdList(ctx, []string{"--project-id", proj.ID, "--worktree-id", wt.ID}); code != 0 || err != nil {
			t.Fatalf("list --worktree-id: %d, %v", code, err)
		}
	})
	one := decodeT[[]worktreeJSON](t, onlyDoc(t, docs))
	if len(one) != 1 || one[0].ID != wt.ID || one[0].PrimaryBranch != "main" {
		t.Fatalf("--worktree-id rows = %+v, want just fox", one)
	}

	// An id that is gone answers with the stable code the app maps.
	if _, err := cmdList(ctx, []string{"--worktree-id", "gone"}); errorKindOf(err) != "unknown-worktree" {
		t.Errorf("unknown --worktree-id: err %v (kind %q), want unknown-worktree", err, errorKindOf(err))
	}
	if _, err := cmdList(ctx, []string{"--project-id", "gone"}); errorKindOf(err) != "unknown-project" {
		t.Errorf("unknown --project-id: err %v (kind %q), want unknown-project", err, errorKindOf(err))
	}
}

// A local-only primary is its own branch.
func TestPrimaryBranchOf(t *testing.T) {
	cases := []struct {
		ref     string
		remotes []string
		want    string
	}{
		{"origin/main", []string{"origin"}, "main"},
		{"main", []string{"origin"}, "main"},
		{"up/stream/dev", []string{"up", "up/stream"}, "dev"},
		{"", []string{"origin"}, ""},
	}
	for _, c := range cases {
		if got := primaryBranchOf(c.ref, c.remotes); got != c.want {
			t.Errorf("primaryBranchOf(%q, %v) = %q, want %q", c.ref, c.remotes, got, c.want)
		}
	}
}

// create marks after building its row; the emitted row must still say
// so, or the app's schema default reads it as off.
func TestCreateRowReportsAutoPullMark(t *testing.T) {
	proj := autoPullSandbox(t)
	setGlobalBool(t, "autoPullNew", true)
	ctx := cliContext{projects: []project{proj}}
	docs := captureJSON(t, func() {
		if code, err := cmdCreate(ctx, []string{"--project-id", proj.ID, "--no-setup", "wolf"}); code != 0 || err != nil {
			t.Fatalf("create: %d, %v", code, err)
		}
	})
	var created, done bool
	for _, raw := range docs {
		doc := decodeT[struct {
			Event    string       `json:"event"`
			Worktree worktreeJSON `json:"worktree"`
		}](t, raw)
		switch doc.Event {
		case "created":
			created = doc.Worktree.AutoPull
		case "done":
			done = doc.Worktree.AutoPull
		}
	}
	if !created || !done {
		t.Fatalf("created/done rows autoPull = %v/%v, want true: %s", created, done, docs)
	}
}

func TestAutoPullVerb(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}
	set := func(mode string) worktreeJSON {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdAutoPull(ctx, []string{mode, "--project-id", proj.ID, "--worktree-id", wt.ID}); code != 0 || err != nil {
				t.Fatalf("autopull %s: %d, %v", mode, code, err)
			}
		})
		doc := decodeT[struct {
			OK       bool         `json:"ok"`
			Worktree worktreeJSON `json:"worktree"`
		}](t, onlyDoc(t, docs))
		if !doc.OK || doc.Worktree.ID != wt.ID {
			t.Fatalf("autopull %s answered %+v", mode, doc)
		}
		return doc.Worktree
	}
	if row := set("on"); !row.AutoPull || !autoPullMarks(t)[wt.ID] {
		t.Fatalf("autopull on: row %v, mark %v", row.AutoPull, autoPullMarks(t)[wt.ID])
	}
	if row := set("off"); row.AutoPull || autoPullMarks(t)[wt.ID] {
		t.Fatalf("autopull off: row %v, mark %v", row.AutoPull, autoPullMarks(t)[wt.ID])
	}

	// The primary takes the mark too, by name from its checkout.
	primaryCtx := resolveContext(proj.Path, []project{proj})
	captureJSON(t, func() {
		if code, err := cmdAutoPull(primaryCtx, []string{"on", "root"}); code != 0 || err != nil {
			t.Fatalf("autopull on root: %d, %v", code, err)
		}
	})
	if !autoPullMarks(t)[worktreeIDFromPath(proj.Path)] {
		t.Fatal("autopull on root didn't mark the primary")
	}

	if code, _ := cmdAutoPull(ctx, []string{"on", "a", "b"}); code != 2 {
		t.Errorf("two refs = exit %d, want 2", code)
	}
}

// done rebuilds its row from the facts it resolved; the row must carry
// the same fields as a list row.
func TestDoneRowCarriesPrimaryBranchAndAutoPull(t *testing.T) {
	proj := projectWithOrigin(t)
	primaryID := worktreeIDFromPath(proj.Path)
	if err := setRegistryMark(autoPullKey, primaryID, true); err != nil {
		t.Fatal(err)
	}
	runGitT(t, proj.Path, "checkout", "-q", "-b", "feature")
	ctx := cliContext{projects: []project{proj}}
	docs := captureJSON(t, func() {
		if code, err := cmdDone(ctx, []string{"--project-id", proj.ID, "--worktree-id", primaryID, "-f"}); code != 0 || err != nil {
			t.Fatalf("done: %d, %v", code, err)
		}
	})
	row := decodeT[struct {
		Worktree worktreeJSON `json:"worktree"`
	}](t, onlyDoc(t, docs)).Worktree
	if row.PrimaryBranch != "main" || !row.AutoPull {
		t.Fatalf("done row primaryBranch %q autoPull %v, want main and true", row.PrimaryBranch, row.AutoPull)
	}
}
