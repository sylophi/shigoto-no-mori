package main

// End-to-end proof for the mirror engine (engine.go), in one process:
// a real daemon driven over its NDJSON control pipe, a stand-in
// gateway doing exactly what the app's will (read the preface, answer
// ok, serve a Mutagen endpoint on the socket), and real directories.
// Nothing here is a double on the sync path: Mutagen scans, watches,
// stages and transitions real files. A session reaches only the root it
// is served, and the sessions a v2 daemon left come back under v3's
// labels.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/mutagen-io/mutagen/pkg/encoding"
	"github.com/mutagen-io/mutagen/pkg/filesystem"
	"github.com/mutagen-io/mutagen/pkg/identifier"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"io"
	"maps"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

// The gateway stand-in: every accepted socket is one mirror stream,
// served at root as the host serves the worktree it opened the stream
// for.
func startTestGateway(t *testing.T, root string) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				line, err := readLineUnbuffered(conn)
				if err != nil {
					conn.Close()
					return
				}
				var preface mirrorPreface
				if err := json.Unmarshal([]byte(line), &preface); err != nil {
					io.WriteString(conn, "error bad preface\n")
					conn.Close()
					return
				}
				io.WriteString(conn, "ok\n")
				_ = serveMirrorEndpoint(conn, root, io.Discard)
			}()
		}
	}()
	return listener.Addr().String()
}

// A running daemon plus the two halves of its control channel.
type testDaemon struct {
	t        *testing.T
	requests io.WriteCloser
	mu       sync.Mutex
	docs     []map[string]any
	done     chan error
}

func startTestDaemon(t *testing.T, gateway, dataDir string) *testDaemon {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	d := &testDaemon{t: t, requests: inW, done: make(chan error, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		d.done <- runMirrorDaemon(ctx, inR, outW, gateway, dataDir, io.Discard)
		outW.Close()
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
		for scanner.Scan() {
			var doc map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &doc); err != nil {
				t.Errorf("daemon emitted a non-JSON line: %q", scanner.Text())
				continue
			}
			d.mu.Lock()
			d.docs = append(d.docs, doc)
			d.mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		cancel()
		inW.Close()
	})
	return d
}

func (d *testDaemon) snapshot() []map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]map[string]any(nil), d.docs...)
}

// Sends a request and waits for its response.
func (d *testDaemon) call(req mirrorRequest) map[string]any {
	d.t.Helper()
	line, err := json.Marshal(req)
	if err != nil {
		d.t.Fatal(err)
	}
	if _, err := d.requests.Write(append(line, '\n')); err != nil {
		d.t.Fatal(err)
	}
	var response map[string]any
	waitForT(d.t, 60*time.Second, "response to "+req.Op, func() bool {
		for _, doc := range d.snapshot() {
			if doc["id"] == req.ID {
				response = doc
				return true
			}
		}
		return false
	})
	return response
}

// The most recent state doc's entry for one session, or nil.
func (d *testDaemon) sessionState(session string) map[string]any {
	docs := d.snapshot()
	for i := len(docs) - 1; i >= 0; i-- {
		if docs[i]["event"] != "state" {
			continue
		}
		sessions, _ := docs[i]["sessions"].([]any)
		for _, entry := range sessions {
			m, _ := entry.(map[string]any)
			if m["session"] == session {
				return m
			}
		}
		return nil
	}
	return nil
}

func waitForT(t *testing.T, timeout time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if ok() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func fileEquals(path, want string) bool {
	data, err := os.ReadFile(path)
	return err == nil && string(data) == want
}

func fileAbsent(path string) bool {
	_, err := os.Stat(path)
	return os.IsNotExist(err)
}

// The serving side reaches the worktree it was opened for and nothing
// else: a session naming another folder there, here a replica, which
// would empty it, syncs into the worktree, and the folder it named is
// never touched.
func TestMirrorServeHoldsTheStreamToItsRoot(t *testing.T) {
	remote := t.TempDir()
	gateway := startTestGateway(t, remote)
	local := t.TempDir()
	named := t.TempDir()
	writeFileT(t, filepath.Join(local, "a.txt"), "from the session\n")
	writeFileT(t, filepath.Join(named, "keep.txt"), "not the peer's\n")
	d := startTestDaemon(t, gateway, filepath.Join(t.TempDir(), "mirror-data"))
	created := d.call(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:  local,
		DeviceID:   "peer-1",
		WorktreeID: "0123456789ab",
		RemoteRoot: named,
		Direction:  "replica",
	})
	if created["ok"] != true {
		t.Fatalf("create failed: %v", created["error"])
	}
	waitForT(t, 30*time.Second, "the session to reach the served root", func() bool {
		return fileEquals(filepath.Join(remote, "a.txt"), "from the session\n")
	})
	if !fileEquals(filepath.Join(named, "keep.txt"), "not the peer's\n") || !fileAbsent(filepath.Join(named, "a.txt")) {
		t.Fatal("the session reached the folder it named")
	}
	d.requests.Close()
	<-d.done
}

func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A data dir v2 left: its sessions persisted with v2's labels and the
// root-anchored .git pointer rule. The rewrite gives each its mode,
// keeps every other label, leaves the labels of a session with a mode
// or no kind alone, unanchors every one's pointer rule, and changes
// nothing on a second pass.
func TestRelabelV2Sessions(t *testing.T) {
	dataDir := t.TempDir()
	dir := filepath.Join(dataDir, filesystem.MutagenSynchronizationSessionsDirectoryName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	persisted := map[string]map[string]string{
		"mirror":   {"copySide": "remote", "localWorktreeId": "ba9876543210"},
		"branch":   {"copySide": "remote", "mirrorBranch": "1", "ignoreMode": "gitignored"},
		"transfer": {"transfer": "1", "localWorktreeId": "ba9876543210"},
		"current":  {"mode": "mirror", "localWorktreeId": "ba9876543210"},
		"kindless": {"localWorktreeId": "ba9876543210"},
	}
	ids := map[string]string{}
	for name, labels := range persisted {
		id, err := identifier.New(identifier.PrefixSynchronization)
		if err != nil {
			t.Fatal(err)
		}
		ids[name] = id
		session := &synchronization.Session{
			Identifier:    id,
			Name:          name,
			Labels:        labels,
			Configuration: &synchronization.Configuration{Ignores: []string{"node_modules", "/.git"}},
		}
		if err := encoding.MarshalAndSaveProtobuf(filepath.Join(dir, id), session); err != nil {
			t.Fatal(err)
		}
	}
	want := map[string]map[string]string{
		"mirror":   {"mode": "mirror", "localWorktreeId": "ba9876543210"},
		"branch":   {"mode": "mirror-branch", "ignoreMode": "gitignored"},
		"transfer": {"mode": "transfer-1", "localWorktreeId": "ba9876543210"},
		"current":  {"mode": "mirror", "localWorktreeId": "ba9876543210"},
		"kindless": {"localWorktreeId": "ba9876543210"},
	}
	check := func() {
		for name, id := range ids {
			session := &synchronization.Session{}
			if err := encoding.LoadAndUnmarshalProtobuf(filepath.Join(dir, id), session); err != nil {
				t.Fatal(err)
			}
			if !maps.Equal(session.Labels, want[name]) {
				t.Errorf("%s: labels %v, want %v", name, session.Labels, want[name])
			}
			if session.Name != name {
				t.Errorf("%s: name became %q", name, session.Name)
			}
			// The root-anchored pointer rule of an older session, made the
			// unanchored one, whatever its labels.
			if ignores := session.Configuration.Ignores; !slices.Equal(ignores, []string{"node_modules", ".git"}) {
				t.Errorf("%s: ignores %v", name, ignores)
			}
		}
	}
	var logs bytes.Buffer
	relabelV2Sessions(dataDir, &logs)
	check()
	relabelV2Sessions(dataDir, &logs)
	check()
	if logs.Len() != 0 {
		t.Errorf("relabel logged: %s", logs.String())
	}
}

// A session a v2 daemon created, its kind in v2's labels, comes back
// from a restart running, its labels rewritten into a mode.
func TestMirrorV2SessionLoadsRelabelled(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "mirror-data")
	local := t.TempDir()
	remote := t.TempDir()
	gateway := startTestGateway(t, remote)
	writeFileT(t, filepath.Join(local, "a.txt"), "a\n")

	first := startTestDaemon(t, gateway, dataDir)
	created := first.call(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:       local,
		DeviceID:        "peer-1",
		RemoteRoot:      remote,
		Name:            "v2",
		Labels:          map[string]string{"copySide": "remote", "mirrorBranch": "1", "localWorktreeId": "ba9876543210"},
		LocalWorktreeID: "ba9876543210",
	})
	if created["ok"] != true {
		t.Fatalf("create failed: %v", created["error"])
	}
	session, _ := created["session"].(string)
	waitForT(t, 30*time.Second, "the first daemon to sync", func() bool {
		return fileEquals(filepath.Join(remote, "a.txt"), "a\n")
	})
	first.requests.Close()
	if err := <-first.done; err != nil {
		t.Fatalf("first daemon exited with: %v", err)
	}

	second := startTestDaemon(t, gateway, dataDir)
	var state map[string]any
	waitForT(t, 45*time.Second, "the relabelled session watching", func() bool {
		state = second.sessionState(session)
		return state != nil && state["status"] == "watching"
	})
	labels, _ := state["labels"].(map[string]any)
	want := map[string]any{"mode": "mirror-branch", "localWorktreeId": "ba9876543210"}
	if !maps.Equal(labels, want) {
		t.Fatalf("labels %v, want %v", labels, want)
	}
	second.requests.Close()
	if err := <-second.done; err != nil {
		t.Fatalf("second daemon exited with: %v", err)
	}
}
