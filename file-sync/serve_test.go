package main

// The peer side's endpoint server (serve.go) against a client that asks
// for more than the host gave: a session id shaped like a path, .git
// read and written under a configuration that propagates it, and a real
// repository's .git asked for by name.

import (
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mutagen-io/mutagen/pkg/identifier"
	"github.com/mutagen-io/mutagen/pkg/logging"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
	"github.com/mutagen-io/mutagen/pkg/synchronization/endpoint/remote"
	"github.com/mutagen-io/mutagen/pkg/synchronization/rsync"
	urlpkg "github.com/mutagen-io/mutagen/pkg/url"
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
		{Path: ".GIT/hooks", New: directory},
		{Path: ".g\u200cit/hooks", New: directory},
		{Path: "link", New: &core.Entry{Kind: core.EntryKind_SymbolicLink, Target: ".git/config"}},
		{Path: "sub/d", New: &core.Entry{Kind: core.EntryKind_Directory, Contents: map[string]*core.Entry{
			"hooks": {Kind: core.EntryKind_SymbolicLink, Target: "../../.git/hooks"},
		}}},
		{Path: "sub/.git", New: directory},
		{Path: "sub/b", New: &core.Entry{Kind: core.EntryKind_Directory, Contents: map[string]*core.Entry{".git": directory}}},
	} {
		results, problems, _, err := endpoint.Transition(ctx, []*core.Change{change})
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0] != nil || len(problems) != 1 || problems[0].Path != change.Path {
			t.Fatalf("a change to %s was not refused as a problem: %v %v", change.Path, results, problems)
		}
	}
	for _, path := range []string{".git/hooks", "sub/.git", "sub/b", "link", "sub/d"} {
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

// A real repository, a primary checkout whose remote's URL holds a
// credential and a linked worktree whose .git is a pointer file: a peer
// that reads .git is refused before anything is read, and one that
// stages into it has only the rest staged, while a worktree file still
// comes; and a nested pointer stays out of the scan under the Docker
// ignore syntax a client may ask for.
func TestServeRefusesARealRepositorysGitByName(t *testing.T) {
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(t.TempDir(), "mutagen"))
	scratch := t.TempDir()
	primary := filepath.Join(scratch, "primary")
	linked := filepath.Join(scratch, "linked")
	git(t, scratch, "init", "-q", "-b", "main", primary)
	writeFileT(t, filepath.Join(primary, "README.md"), "hello\n")
	git(t, primary, "add", "README.md")
	git(t, primary, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first")
	git(t, primary, "remote", "add", "origin", "https://someone:secret-token@example.com/repo.git")
	git(t, primary, "worktree", "add", "-q", "-b", "linked", linked)
	writeFileT(t, filepath.Join(primary, "vendor", "lib", ".git"), "gitdir: ../../.git/modules/lib\n")

	for _, served := range []struct {
		root   string
		asked  []string
		reader string
	}{
		{primary, []string{".git/config", ".git/hooks/pre-commit", ".g\u200cit/hooks/pre-commit", "vendor/lib/.git"}, "README.md"},
		{linked, []string{".git"}, "README.md"},
	} {
		session, err := identifier.New(identifier.PrefixSynchronization)
		if err != nil {
			t.Fatal(err)
		}
		endpoint, err := dialServed(t, served.root, session, &synchronization.Configuration{
			IgnoreSyntax: ignore.Syntax_SyntaxDocker,
		})
		if err != nil {
			t.Fatal(err)
		}
		snapshot, err, _ := endpoint.Scan(context.Background(), nil, true)
		if err != nil {
			t.Fatal(err)
		}
		if vendored := snapshot.Content.Contents["vendor"]; vendored != nil {
			if pointer := vendored.Contents["lib"].Contents[".git"]; pointer != nil && pointer.Kind != core.EntryKind_Untracked {
				t.Fatalf("%s: the scan carried a nested .git", served.root)
			}
		}
		if got := supplied(t, endpoint, served.reader); got != "hello\n" {
			t.Fatalf("%s: %s came as %q", served.root, served.reader, got)
		}
		// Staging the .git paths beside a worktree file stages the file alone.
		session, err = identifier.New(identifier.PrefixSynchronization)
		if err != nil {
			t.Fatal(err)
		}
		staging, err := dialServed(t, served.root, session, &synchronization.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err, _ := staging.Scan(context.Background(), nil, true); err != nil {
			t.Fatal(err)
		}
		paths := append(served.asked, "new.txt")
		digests := make([][]byte, len(paths))
		for d := range digests {
			digests[d] = []byte{1}
		}
		staged, _, _, err := staging.Stage(paths, digests)
		if err != nil {
			t.Fatalf("%s: staging was refused: %v", served.root, err)
		}
		if len(staged) != 1 || staged[0] != "new.txt" {
			t.Fatalf("%s: staged %v", served.root, staged)
		}
	}
	// Each refusal ends the stream, so each read is asked on its own.
	for _, path := range []string{".git/config", ".GIT/config", ".g\u200cit/config", ".git\ufeff/config", ".Git/hooks/pre-commit", "vendor/lib/.git"} {
		session, err := identifier.New(identifier.PrefixSynchronization)
		if err != nil {
			t.Fatal(err)
		}
		endpoint, err := dialServed(t, primary, session, &synchronization.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		if got, err := supply(endpoint, path); err == nil || bytes.Contains([]byte(got), []byte("secret-token")) {
			t.Fatalf("%s was read: %q", path, got)
		}
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	// Not the repository a hook that runs this test is committing in
	// (../test/gitIsolation.ts).
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GIT_") {
			command.Env = append(command.Env, entry)
		}
	}
	// Nor the machine's own config: a signing key, hooks, templates.
	command.Env = append(command.Env,
		"GIT_CEILING_DIRECTORIES="+filepath.Dir(dir),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
	)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// What the served side sends for path, whole.
func supplied(t *testing.T, endpoint synchronization.Endpoint, path string) string {
	t.Helper()
	got, err := supply(endpoint, path)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func supply(endpoint synchronization.Endpoint, path string) (string, error) {
	sink := &memorySinker{files: map[string]*bytes.Buffer{}}
	paths := []string{path}
	signatures := []*rsync.Signature{{}}
	receiver, err := rsync.NewReceiver(os.TempDir(), paths, signatures, sink)
	if err != nil {
		return "", err
	}
	err = endpoint.Supply(paths, signatures, receiver)
	if buffer := sink.files[path]; buffer != nil {
		return buffer.String(), err
	}
	return "", err
}

type memorySinker struct {
	files map[string]*bytes.Buffer
}

func (s *memorySinker) Sink(path string) (io.WriteCloser, error) {
	buffer := &bytes.Buffer{}
	s.files[path] = buffer
	return nopWriteCloser{buffer}, nil
}

type nopWriteCloser struct {
	io.Writer
}

func (nopWriteCloser) Close() error { return nil }

// The daemon's own side refuses .git too, whatever the peer's scan
// asked it to write or read.
func TestTheDaemonsLocalSideHoldsGit(t *testing.T) {
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(t.TempDir(), "mutagen"))
	root := filepath.Join(t.TempDir(), "repo")
	git(t, filepath.Dir(root), "init", "-q", "-b", "main", root)
	holdGitOnLocalEndpoints()
	session, err := identifier.New(identifier.PrefixSynchronization)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := synchronization.ProtocolHandlers[urlpkg.Protocol_Local].Connect(
		context.Background(),
		logging.NewLogger(logging.LevelDisabled, io.Discard),
		&urlpkg.URL{Kind: urlpkg.Kind_Synchronization, Protocol: urlpkg.Protocol_Local, Path: root},
		"",
		session,
		synchronization.DefaultVersion,
		&synchronization.Configuration{},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { endpoint.Shutdown() })
	if _, err, _ := endpoint.Scan(context.Background(), nil, true); err != nil {
		t.Fatal(err)
	}
	hooks := &core.Entry{Kind: core.EntryKind_Directory}
	if _, problems, _, err := endpoint.Transition(context.Background(), []*core.Change{{Path: ".GIT/hooks2", New: hooks}}); err != nil || len(problems) != 1 {
		t.Fatalf("a change under .GIT was not refused as a problem: %v %v", problems, err)
	}
	if _, err := os.Lstat(filepath.Join(root, ".git", "hooks2")); err == nil {
		t.Fatal(".git/hooks2 was written")
	}
	if _, err := supply(endpoint, ".git/config"); err == nil {
		t.Fatal(".git/config was read")
	}
}
