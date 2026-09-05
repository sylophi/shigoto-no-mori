package main

// End-to-end proof for the mirror engine (engine.go), in one process:
// a real daemon driven over its NDJSON control pipe, a stand-in
// gateway doing exactly what the app's will (read the preface, answer
// ok, serve a Mutagen endpoint on the socket), and two real
// directories that must converge in both directions. Nothing here is
// a double on the sync path: Mutagen scans, watches, stages and
// transitions real files.

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/mutagen-io/mutagen/pkg/selection"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The gateway stand-in: every accepted socket is one mirror stream.
// Records each preface so the test can pin what the daemon announces.
func startTestGateway(t *testing.T) (addr string, prefaces func() []mirrorPreface) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	var mu sync.Mutex
	var seen []mirrorPreface
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
				mu.Lock()
				seen = append(seen, preface)
				mu.Unlock()
				if preface.DeviceID != "peer-1" {
					io.WriteString(conn, "error unknown device\n")
					conn.Close()
					return
				}
				io.WriteString(conn, "ok\n")
				_ = serveMirrorEndpoint(conn, io.Discard)
			}()
		}
	}()
	return listener.Addr().String(), func() []mirrorPreface {
		mu.Lock()
		defer mu.Unlock()
		return append([]mirrorPreface(nil), seen...)
	}
}

// A running daemon plus the two halves of its control channel.
type testDaemon struct {
	t        *testing.T
	requests io.WriteCloser
	mu       sync.Mutex
	docs     []map[string]any
	done     chan error
	logs     *syncBuffer
}

// The daemon's stderr (Mutagen's warnings included), for failure
// messages.
type syncBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startTestDaemon(t *testing.T, gateway, dataDir string) *testDaemon {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	logs := &syncBuffer{}
	d := &testDaemon{t: t, requests: inW, done: make(chan error, 1), logs: logs}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		d.done <- runMirrorDaemon(ctx, inR, outW, gateway, dataDir, logs)
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

func TestMirrorTwoWayOverGateway(t *testing.T) {
	gateway, prefaces := startTestGateway(t)
	dataDir := filepath.Join(t.TempDir(), "mirror-data")
	local := filepath.Join(t.TempDir(), "local")
	remote := filepath.Join(t.TempDir(), "remote")
	for _, dir := range []string{local, remote} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Seeded before the session exists: the initial reconciliation must
	// carry existing content across, including a gitignored-looking
	// file and a nested one.
	writeFileT(t, filepath.Join(local, "src", "main.go"), "package main\n")
	writeFileT(t, filepath.Join(local, ".env"), "SECRET=1\n")
	// A linked worktree's .git is a FILE naming a machine-specific
	// gitdir. It must never cross.
	writeFileT(t, filepath.Join(local, ".git"), "gitdir: /Users/someone/repo/.git/worktrees/x\n")
	writeFileT(t, filepath.Join(remote, "notes.md"), "from the peer\n")

	d := startTestDaemon(t, gateway, dataDir)
	waitForT(t, 10*time.Second, "ready", func() bool {
		for _, doc := range d.snapshot() {
			if doc["event"] == "ready" {
				return true
			}
		}
		return false
	})

	created := d.call(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:  local,
		DeviceID:   "peer-1",
		ProjectID:  "proj-a",
		WorktreeID: "0123456789ab",
		RemoteRoot: remote,
		Name:       "feature-x",
		Labels:     map[string]string{"localWorktreeId": "ba9876543210"},
	})
	if created["ok"] != true {
		t.Fatalf("create failed: %v", created["error"])
	}
	session, _ := created["session"].(string)
	if session == "" {
		t.Fatal("create returned no session id")
	}

	// Initial convergence, both directions.
	waitForT(t, 30*time.Second, "seed to reach the peer", func() bool {
		return fileEquals(filepath.Join(remote, "src", "main.go"), "package main\n") &&
			fileEquals(filepath.Join(remote, ".env"), "SECRET=1\n") &&
			fileEquals(filepath.Join(local, "notes.md"), "from the peer\n")
	})
	if !fileAbsent(filepath.Join(remote, ".git")) {
		t.Fatal(".git crossed to the peer")
	}

	// Live edits after the session is watching: local to remote, remote
	// to local, a delete, a nested new directory.
	writeFileT(t, filepath.Join(local, "src", "main.go"), "package main\n// edited\n")
	waitForT(t, 30*time.Second, "local edit to reach the peer", func() bool {
		return fileEquals(filepath.Join(remote, "src", "main.go"), "package main\n// edited\n")
	})
	writeFileT(t, filepath.Join(remote, "node_modules", "dep", "index.js"), "module.exports = 1\n")
	waitForT(t, 30*time.Second, "remote nested write to reach local", func() bool {
		return fileEquals(filepath.Join(local, "node_modules", "dep", "index.js"), "module.exports = 1\n")
	})
	if err := os.Remove(filepath.Join(local, ".env")); err != nil {
		t.Fatal(err)
	}
	waitForT(t, 30*time.Second, "local delete to reach the peer", func() bool {
		return fileAbsent(filepath.Join(remote, ".env"))
	})
	if !fileAbsent(filepath.Join(remote, ".git")) {
		t.Fatal(".git crossed to the peer after live cycles")
	}

	// The state stream describes the session in the app's vocabulary.
	waitForT(t, 30*time.Second, "a watching state snapshot", func() bool {
		state := d.sessionState(session)
		return state != nil && state["status"] == "watching"
	})
	state := d.sessionState(session)
	for key, want := range map[string]any{
		"name":       "feature-x",
		"localRoot":  local,
		"deviceId":   "peer-1",
		"projectId":  "proj-a",
		"worktreeId": "0123456789ab",
		"remoteRoot": remote,
		"paused":     false,
	} {
		if state[key] != want {
			t.Errorf("state[%s] = %v, want %v", key, state[key], want)
		}
	}
	labels, _ := state["labels"].(map[string]any)
	if labels["localWorktreeId"] != "ba9876543210" {
		t.Errorf("labels = %v", state["labels"])
	}
	localState, _ := state["local"].(map[string]any)
	remoteState, _ := state["remote"].(map[string]any)
	if localState["connected"] != true || remoteState["connected"] != true {
		t.Errorf("endpoints not both connected: %v / %v", localState, remoteState)
	}
	if cycles, _ := state["successfulCycles"].(float64); cycles < 1 {
		t.Errorf("successfulCycles = %v", state["successfulCycles"])
	}
	if conflicts, _ := state["conflicts"].([]any); len(conflicts) != 0 {
		t.Errorf("unexpected conflicts: %v", conflicts)
	}

	// The gateway learned who the stream is for.
	seen := prefaces()
	if len(seen) == 0 {
		t.Fatal("gateway saw no preface")
	}
	if seen[0].DeviceID != "peer-1" || seen[0].ProjectID != "proj-a" ||
		seen[0].WorktreeID != "0123456789ab" {
		t.Errorf("preface = %+v", seen[0])
	}

	// Pause stops propagation. Resume picks it back up.
	if paused := d.call(mirrorRequest{ID: "2", Op: "pause", Session: session}); paused["ok"] != true {
		t.Fatalf("pause failed: %v", paused["error"])
	}
	waitForT(t, 10*time.Second, "paused state", func() bool {
		state := d.sessionState(session)
		return state != nil && state["paused"] == true
	})
	writeFileT(t, filepath.Join(local, "while-paused.txt"), "held\n")
	time.Sleep(1500 * time.Millisecond)
	if !fileAbsent(filepath.Join(remote, "while-paused.txt")) {
		t.Fatal("a paused session propagated a write")
	}
	if resumed := d.call(mirrorRequest{ID: "3", Op: "resume", Session: session}); resumed["ok"] != true {
		t.Fatalf("resume failed: %v", resumed["error"])
	}
	waitForT(t, 30*time.Second, "held write to cross after resume", func() bool {
		return fileEquals(filepath.Join(remote, "while-paused.txt"), "held\n")
	})

	// Terminate removes the session. The files stay where they are.
	if terminated := d.call(mirrorRequest{ID: "4", Op: "terminate", Session: session}); terminated["ok"] != true {
		t.Fatalf("terminate failed: %v", terminated["error"])
	}
	waitForT(t, 10*time.Second, "session gone from state", func() bool {
		return d.sessionState(session) == nil
	})
	if !fileEquals(filepath.Join(remote, "src", "main.go"), "package main\n// edited\n") {
		t.Fatal("terminate touched the mirrored files")
	}

	// Closing the control channel ends the daemon cleanly.
	d.requests.Close()
	select {
	case err := <-d.done:
		if err != nil {
			t.Fatalf("daemon exited with: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("daemon did not exit after stdin closed")
	}
}

// A label value outside Mutagen's alphabet would make the session
// vanish on the next daemon start (the load-time check), and the app
// reads identity out of the labels, so the create refuses instead of
// folding the value.
func TestMirrorCreateRefusesInvalidLabel(t *testing.T) {
	gateway, _ := startTestGateway(t)
	daemon := startTestDaemon(t, gateway, filepath.Join(t.TempDir(), "data"))
	created := daemon.call(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:  t.TempDir(),
		DeviceID:   "peer-1",
		RemoteRoot: t.TempDir(),
		Name:       "feat/mirror",
		Labels:     map[string]string{"branch": "feat/mirror"},
	})
	if created["ok"] != false {
		t.Fatalf("create with an invalid label value succeeded: %v", created)
	}
	if msg, _ := created["error"].(string); !strings.Contains(msg, "label") {
		t.Fatalf("refusal does not name the label: %v", created["error"])
	}
	daemon.requests.Close()
	<-daemon.done
}

func TestMirrorCreateRefusesUnreachablePeer(t *testing.T) {
	gateway, _ := startTestGateway(t)
	dataDir := filepath.Join(t.TempDir(), "mirror-data")
	local := t.TempDir()
	remote := t.TempDir()
	d := startTestDaemon(t, gateway, dataDir)
	// The gateway refuses any device but peer-1, standing in for a peer
	// that is offline or ungranted: create must fail with the gateway's
	// reason instead of minting a session that can never connect.
	created := d.call(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:  local,
		DeviceID:   "peer-offline",
		RemoteRoot: remote,
	})
	if created["ok"] != false {
		t.Fatalf("create against an unreachable peer succeeded: %v", created)
	}
	msg, _ := created["error"].(string)
	if !strings.Contains(msg, "unknown device") {
		t.Errorf("error = %q, want the gateway's reason", msg)
	}
	d.requests.Close()
	if err := <-d.done; err != nil {
		t.Fatalf("daemon exited with: %v", err)
	}
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

// The host's SIGTERM path: the daemon must exit promptly on context
// cancellation even while its stdin stays open and a request is
// parked on a connect that will never answer.
func TestMirrorDaemonExitsOnCancelWithStdinOpen(t *testing.T) {
	// A gateway that accepts and then never answers the preface, so a
	// create blocks inside its connect until cancelled.
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
			t.Cleanup(func() { conn.Close() })
		}
	}()
	dataDir := filepath.Join(t.TempDir(), "mirror-data")
	inR, inW := io.Pipe()
	t.Cleanup(func() { inW.Close() })
	outR, outW := io.Pipe()
	go io.Copy(io.Discard, outR)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runMirrorDaemon(ctx, inR, outW, listener.Addr().String(), dataDir, io.Discard)
		outW.Close()
	}()
	// Give the daemon a moment to come up, then park a create on the
	// silent gateway.
	time.Sleep(200 * time.Millisecond)
	req, _ := json.Marshal(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:  t.TempDir(),
		DeviceID:   "peer-1",
		RemoteRoot: t.TempDir(),
	})
	if _, err := inW.Write(append(req, '\n')); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon did not exit on cancellation while stdin stayed open")
	}
}

// A session created under a name Mutagen would reject on load (the
// branch name, slash included) must still be there after the daemon
// restarts: persistence is the whole point of the daemon's data dir.
func TestMirrorSessionSurvivesDaemonRestart(t *testing.T) {
	gateway, _ := startTestGateway(t)
	dataDir := filepath.Join(t.TempDir(), "mirror-data")
	local := t.TempDir()
	remote := t.TempDir()
	writeFileT(t, filepath.Join(local, "a.txt"), "a\n")

	first := startTestDaemon(t, gateway, dataDir)
	created := first.call(mirrorRequest{
		ID: "1", Op: "create",
		LocalRoot:  local,
		DeviceID:   "peer-1",
		RemoteRoot: remote,
		Name:       "feat/mirror",
		Labels:     map[string]string{"localWorktreeId": "ba9876543210"},
	})
	if created["ok"] != true {
		t.Fatalf("create failed: %v", created["error"])
	}
	session, _ := created["session"].(string)
	waitForT(t, 30*time.Second, "the first daemon to sync", func() bool {
		return fileEquals(filepath.Join(remote, "a.txt"), "a\n")
	})
	// State docs are throttled (streamMirrorState), so the one naming
	// the session may trail the files by a beat.
	var state map[string]any
	waitForT(t, 10*time.Second, "the session state", func() bool {
		state = first.sessionState(session)
		return state != nil
	})
	if state["name"] != "feat-mirror" {
		t.Fatalf("session name not folded into Mutagen's alphabet: %v", state)
	}
	first.requests.Close()
	if err := <-first.done; err != nil {
		t.Fatalf("first daemon exited with: %v", err)
	}

	second := startTestDaemon(t, gateway, dataDir)
	deadline := time.Now().Add(45 * time.Second)
	for {
		s := second.sessionState(session)
		if s != nil && s["status"] == "watching" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restarted daemon never reported the session watching; last state %v; docs %d; daemon log:\n%s", s, len(second.snapshot()), second.logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	labels, _ := second.sessionState(session)["labels"].(map[string]any)
	if labels["localWorktreeId"] != "ba9876543210" {
		t.Fatalf("labels lost across the restart: %v", labels)
	}
	writeFileT(t, filepath.Join(local, "b.txt"), "b\n")
	waitForT(t, 30*time.Second, "the restarted session to sync", func() bool {
		return fileEquals(filepath.Join(remote, "b.txt"), "b\n")
	})
	second.requests.Close()
	if err := <-second.done; err != nil {
		t.Fatalf("second daemon exited with: %v", err)
	}
}

// The name is folded into Mutagen's alphabet and pushed out of the
// shapes it refuses on load (a UUID, a reserved word), so a session
// never vanishes over a cosmetic name.
func TestMirrorSessionNameFolding(t *testing.T) {
	cases := map[string]string{
		"feat/mirror":                          "feat-mirror",
		"123-start":                            "m-123-start",
		"defaults":                             "m-defaults",
		"d9d02c4d-6328-4cb2-95ac-1eedde979ee0": "m-d9d02c4d-6328-4cb2-95ac-1eedde979ee0",
	}
	for in, want := range cases {
		got := mirrorSessionName(in)
		if got != want {
			t.Errorf("mirrorSessionName(%q) = %q, want %q", in, got, want)
		}
		if err := selection.EnsureNameValid(got); err != nil {
			t.Errorf("mirrorSessionName(%q) = %q is still invalid: %v", in, got, err)
		}
	}
}
