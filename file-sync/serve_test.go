package main

// The peer side's endpoint server (serve.go) against a client that asks
// for more than the host gave: a session id shaped like a path, and
// .git read and written under a configuration that propagates it.

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/mutagen-io/mutagen/pkg/identifier"
	"github.com/mutagen-io/mutagen/pkg/logging"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
	"github.com/mutagen-io/mutagen/pkg/synchronization/endpoint/remote"
)

// A client endpoint on a stream served at root, as a peer opens one.
func dialServed(t *testing.T, root, session string, configuration *synchronization.Configuration) (synchronization.Endpoint, error) {
	t.Helper()
	// A socket, as the gateway hands one over: a synchronous pipe would
	// stall both ends writing at once.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		if served, err := listener.Accept(); err == nil {
			_ = serveMirrorEndpoint(served, root, io.Discard)
		}
	}()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := remote.NewEndpoint(
		logging.NewLogger(logging.LevelDisabled, io.Discard),
		client,
		root,
		session,
		synchronization.DefaultVersion,
		configuration,
		false,
	)
	if err == nil {
		t.Cleanup(func() { endpoint.Shutdown() })
	}
	return endpoint, err
}

// Mutagen joins the session id into the cache and staging paths it
// writes and removes, so one that is a path reaches out of its folder.
func TestServeRefusesASessionThatIsAPath(t *testing.T) {
	scratch := t.TempDir()
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(scratch, "mutagen"))
	victim := filepath.Join(scratch, "victim-beta")
	writeFileT(t, filepath.Join(victim, "keep.txt"), "mine\n")
	root := t.TempDir()
	_, err := dialServed(t, root, "../../victim", &synchronization.Configuration{})
	if err == nil {
		t.Fatal("a session id shaped like a path was served")
	}
	if !fileEquals(filepath.Join(victim, "keep.txt"), "mine\n") {
		t.Fatal("the folder the session named was touched")
	}
}

// A peer that asks for .git sees none of it and changes none of it,
// at the top or deeper, while the rest of the worktree is its to change.
func TestServeKeepsGitOutOfReach(t *testing.T) {
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(t.TempDir(), "mutagen"))
	root := t.TempDir()
	writeFileT(t, filepath.Join(root, ".git", "config"), "[remote \"origin\"]\n")
	writeFileT(t, filepath.Join(root, "sub", "a.txt"), "a\n")
	session, err := identifier.New(identifier.PrefixSynchronization)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := dialServed(t, root, session, &synchronization.Configuration{
		IgnoreVCSMode: ignore.IgnoreVCSMode_IgnoreVCSModePropagate,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	snapshot, err, _ := endpoint.Scan(ctx, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	// An ignored path is reported as untracked, with nothing of it.
	if git := snapshot.Content.Contents[".git"]; git != nil && (git.Kind != core.EntryKind_Untracked || len(git.Contents) != 0) {
		t.Fatal("the scan carried .git")
	}
	directory := &core.Entry{Kind: core.EntryKind_Directory}
	for _, change := range []*core.Change{
		{Path: ".git/hooks", New: directory},
		{Path: "sub/.git", New: directory},
		{Path: "sub/b", New: &core.Entry{Kind: core.EntryKind_Directory, Contents: map[string]*core.Entry{".git": directory}}},
	} {
		if _, _, _, err := endpoint.Transition(ctx, []*core.Change{change}); err == nil {
			t.Fatalf("a change to %s was applied", change.Path)
		}
	}
	for _, path := range []string{".git/hooks", "sub/.git", "sub/b"} {
		if _, err := os.Lstat(filepath.Join(root, path)); err == nil {
			t.Fatalf("%s was written", path)
		}
	}
	if _, _, _, err := endpoint.Transition(ctx, []*core.Change{{Path: "sub/c", New: directory}}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(root, "sub", "c")); err != nil || !info.IsDir() {
		t.Fatal("an ordinary change was not applied")
	}
}
