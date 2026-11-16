package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/mutagen-io/mutagen/pkg/identifier"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core"
)

// A name Windows would store under another one, or as a device, is
// never made here, alone or inside a folder, which keeps the rest of
// its contents.
func TestServeLeavesOutNamesWindowsCantKeep(t *testing.T) {
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(t.TempDir(), "mutagen"))
	root := t.TempDir()
	session, err := identifier.New(identifier.PrefixSynchronization)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := dialServed(t, root, session, &synchronization.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	scan := func() {
		t.Helper()
		if _, err, _ := endpoint.Scan(ctx, nil, true); err != nil {
			t.Fatal(err)
		}
	}
	scan()
	directory := &core.Entry{Kind: core.EntryKind_Directory}
	for _, path := range []string{"x.", "y ", "aux.txt", "COM1", "d./e"} {
		results, problems, _, err := endpoint.Transition(ctx, []*core.Change{{Path: path, New: directory}})
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0] != nil || len(problems) != 1 || problems[0].Path != path {
			t.Fatalf("a change to %q was not refused as a problem: %v %v", path, results, problems)
		}
		scan()
	}
	folder := &core.Change{Path: "f", New: &core.Entry{Kind: core.EntryKind_Directory, Contents: map[string]*core.Entry{
		"ok":  directory,
		"x.":  directory,
		"nul": directory,
	}}}
	results, problems, _, err := endpoint.Transition(ctx, []*core.Change{folder})
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 2 || len(results[0].Contents) != 1 || results[0].Contents["ok"] == nil {
		t.Fatalf("the folder came back as %v with %v", results[0], problems)
	}
	if folder.New.Contents["x."] == nil {
		t.Fatal("the change asked for was altered")
	}
	if names := listed(t, root); !slices.Equal(names, []string{"f"}) {
		t.Fatalf("the root holds %q", names)
	}
	if names := listed(t, filepath.Join(root, "f")); !slices.Equal(names, []string{"ok"}) {
		t.Fatalf("the folder holds %q", names)
	}
}

func listed(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}
