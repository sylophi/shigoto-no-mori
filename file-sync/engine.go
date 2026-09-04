package main

// file-sync: the engine behind continuous worktree mirroring between
// devices (PRODUCT.md, "Three ways to reach remote work"). A mirrored
// worktree is kept identical on two machines, every file and not only
// what git tracks, in both directions, as edits happen. The
// synchronization itself is Mutagen's library (three-way reconciliation
// against a persisted ancestor, rsync-style deltas, native filesystem
// watching, staged atomic writes, conflicts reported instead of
// resolved by guessing). Building that engine in-house would be the
// clever mechanism. Embedding the conventional one is the boring
// choice, so Mutagen it is.
//
// This is a separate binary from the sm CLI on purpose. The CLI is the
// engine the app and a terminal share. Nobody types these commands,
// only the app's host process spawns them, so they live here where the
// server's concerns stay the server's. Two roles, one binary:
//
//   - `file-sync serve` is the PEER side of one mirror stream. It
//     serves a Mutagen endpoint over its own stdin/stdout until the
//     other end hangs up. The host spawns one per incoming stream and
//     shuttles the bytes over the device wire, so this process never
//     knows a network exists.
//
//   - `file-sync daemon --gateway <host:port> --data-dir <dir>` is the
//     LOCAL side: a long-lived Mutagen session manager for every mirror
//     this device participates in as the initiator. It is driven over
//     stdin/stdout with NDJSON (requests in, responses and state
//     snapshots out) by the host, and it dies when stdin closes, so a
//     dead app never leaves a headless daemon behind. Sessions persist
//     under the data directory the host names and resume on the next
//     daemon start.
//
// The host owns the lifecycle, fully. Nothing here starts on its own:
// the host spawns both roles, and each one stops the moment the host
// does. Three independent tripwires make that hold even when the host
// dies without cleaning up: stdin reaching EOF (the kernel closes the
// host's end of the pipe when its process ends, whatever the cause),
// SIGTERM from the host's quit-time reap, and a watchdog that exits
// when the parent pid changes (main.go, watchParent). A daemon that
// outlives the app would keep mirroring with nobody to show or stop
// it, which is exactly the state this design refuses to allow.
//
// The wire between the two is the host's problem, on purpose. The
// daemon reaches a peer through a loopback GATEWAY the host listens on:
// the Mutagen protocol handler dials it, writes one JSON preface line
// naming the peer device and worktree, waits for the gateway's "ok"
// line (the host opened the peer-side serve process by then), and hands
// the socket to Mutagen as the endpoint stream. Reconnects are
// Mutagen's own run loop calling the handler again, so a peer that
// went offline is simply retried until it is back.
//
// Mutagen validates URL protocols against a fixed enum and refuses
// unknown ones, so the gateway handler registers under the SSH slot.
// Nothing else in this binary imports Mutagen's SSH protocol package,
// so the slot is free, and the "SSH" URL below is just the carrier of
// a device id (Host), a root path (Path) and the peer worktree identity
// (Parameters). No ssh is involved anywhere.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/mutagen-io/mutagen/pkg/logging"
	"github.com/mutagen-io/mutagen/pkg/selection"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
	"github.com/mutagen-io/mutagen/pkg/synchronization/endpoint/remote"
	// Registers the Local protocol handler (init side effect), which
	// the alpha side of every session connects through.
	_ "github.com/mutagen-io/mutagen/pkg/synchronization/protocols/local"
	urlpkg "github.com/mutagen-io/mutagen/pkg/url"
)

// The URL parameters that carry the peer worktree identity to the
// gateway preface. Mutagen persists them with the session, so a
// reconnect after a daemon restart still names the right worktree.
const (
	mirrorParamProjectID  = "projectId"
	mirrorParamWorktreeID = "worktreeId"
)

// Mutagen's VCS ignore covers a .git DIRECTORY. A linked worktree's
// .git is a FILE (one line naming the gitdir), so it needs its own
// root-anchored pattern, or the pointer would land on the peer and aim
// its worktree at a path that does not exist there.
const mirrorGitPointerIgnore = "/.git"

// How long the gateway may take to open the peer-side stream before
// the connect attempt is abandoned and left to Mutagen's retry loop.
const mirrorGatewayTimeout = 30 * time.Second

// ---------------------------------------------------------------------
// Peer side

// Serves one Mutagen endpoint over the stream until the client ends it.
// The stream must unblock reads and writes when closed (Mutagen's
// contract). Pipes and sockets do.
func serveMirrorEndpoint(stream io.ReadWriteCloser, logOut io.Writer) error {
	logger := logging.NewLogger(logging.LevelWarn, logOut)
	return remote.ServeEndpoint(logger, stream)
}

// stdin/stdout as the single stream serve needs.
type stdioStream struct {
	in  io.ReadCloser
	out io.WriteCloser
}

func (s stdioStream) Read(p []byte) (int, error)  { return s.in.Read(p) }
func (s stdioStream) Write(p []byte) (int, error) { return s.out.Write(p) }
func (s stdioStream) Close() error {
	inErr := s.in.Close()
	outErr := s.out.Close()
	if inErr != nil {
		return inErr
	}
	return outErr
}

// ---------------------------------------------------------------------
// Gateway protocol handler (local side)

// What the daemon tells the gateway before any Mutagen byte flows: the
// peer to reach and the worktree there. The gateway answers with one
// line, "ok" or "error <message>".
type mirrorPreface struct {
	DeviceID   string `json:"deviceId"`
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId"`
	Session    string `json:"session"`
}

type mirrorGatewayHandler struct {
	gateway string
}

func (h mirrorGatewayHandler) Connect(
	ctx context.Context,
	logger *logging.Logger,
	u *urlpkg.URL,
	_ string,
	session string,
	version synchronization.Version,
	configuration *synchronization.Configuration,
	alpha bool,
) (synchronization.Endpoint, error) {
	dialer := net.Dialer{Timeout: mirrorGatewayTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", h.gateway)
	if err != nil {
		return nil, fmt.Errorf("mirror gateway unreachable: %w", err)
	}
	// The handshake below (our preface exchange, then Mutagen's) is a
	// series of blocking reads with only the wall-clock deadline for
	// company. Cancellation must cut it short too: a daemon shutting
	// down (the host closed the pipe or sent SIGTERM) waits for
	// in-flight connects, and a peer that accepted but never answers
	// would otherwise hold the exit for the full timeout. Closing the
	// conn unblocks every read. Once the endpoint is established the
	// conn is Mutagen's and this watcher stands down.
	handshakeDone := make(chan struct{})
	defer close(handshakeDone)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-handshakeDone:
		}
	}()
	preface := mirrorPreface{
		DeviceID:   u.Host,
		ProjectID:  u.Parameters[mirrorParamProjectID],
		WorktreeID: u.Parameters[mirrorParamWorktreeID],
		Session:    session,
	}
	if err := conn.SetDeadline(time.Now().Add(mirrorGatewayTimeout)); err != nil {
		conn.Close()
		return nil, err
	}
	line, err := json.Marshal(preface)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		conn.Close()
		return nil, fmt.Errorf("mirror gateway preface: %w", err)
	}
	// Byte-at-a-time so nothing past the newline is swallowed: the
	// bytes after "ok" belong to Mutagen's handshake.
	answer, err := readLineUnbuffered(conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("mirror gateway answer: %w", err)
	}
	if answer != "ok" {
		conn.Close()
		return nil, errors.New(strings.TrimPrefix(answer, "error "))
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, err
	}
	// NewEndpoint owns the conn from here, closing it on failure too.
	return remote.NewEndpoint(logger, conn, u.Path, session, version, configuration, alpha)
}

func readLineUnbuffered(r io.Reader) (string, error) {
	var line []byte
	buf := make([]byte, 1)
	for {
		n, err := r.Read(buf)
		if n == 1 {
			if buf[0] == '\n' {
				return strings.TrimRight(string(line), "\r"), nil
			}
			line = append(line, buf[0])
			if len(line) > 4096 {
				return "", errors.New("line too long")
			}
		}
		if err != nil {
			return "", err
		}
	}
}

// ---------------------------------------------------------------------
// Daemon control protocol

// One request line on the daemon's stdin. `id` is echoed on the
// response so the app can match them. `op` picks the verb.
type mirrorRequest struct {
	ID string `json:"id"`
	Op string `json:"op"`
	// create
	LocalRoot  string            `json:"localRoot,omitempty"`
	DeviceID   string            `json:"deviceId,omitempty"`
	ProjectID  string            `json:"projectId,omitempty"`
	WorktreeID string            `json:"worktreeId,omitempty"`
	RemoteRoot string            `json:"remoteRoot,omitempty"`
	Name       string            `json:"name,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	// terminate, pause, resume
	Session string `json:"session,omitempty"`
}

type mirrorResponse struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Session string `json:"session,omitempty"`
	Error   string `json:"error,omitempty"`
}

// The state snapshot the daemon streams whenever any session moves.
type mirrorStateDoc struct {
	Event    string               `json:"event"`
	Index    uint64               `json:"index"`
	Sessions []mirrorSessionState `json:"sessions"`
}

type mirrorSessionState struct {
	Session    string            `json:"session"`
	Name       string            `json:"name"`
	Labels     map[string]string `json:"labels"`
	LocalRoot  string            `json:"localRoot"`
	DeviceID   string            `json:"deviceId"`
	ProjectID  string            `json:"projectId"`
	WorktreeID string            `json:"worktreeId"`
	RemoteRoot string            `json:"remoteRoot"`
	Paused     bool              `json:"paused"`
	// A stable kebab-case code (see mirrorStatusCode) plus Mutagen's
	// human description.
	Status            string              `json:"status"`
	StatusText        string              `json:"statusText"`
	LastError         string              `json:"lastError,omitempty"`
	SuccessfulCycles  uint64              `json:"successfulCycles"`
	Conflicts         []mirrorConflict    `json:"conflicts"`
	ExcludedConflicts uint64              `json:"excludedConflicts"`
	Local             mirrorEndpointState `json:"local"`
	Remote            mirrorEndpointState `json:"remote"`
}

type mirrorEndpointState struct {
	Connected        bool            `json:"connected"`
	Scanned          bool            `json:"scanned"`
	Directories      uint64          `json:"directories"`
	Files            uint64          `json:"files"`
	SymbolicLinks    uint64          `json:"symbolicLinks"`
	TotalFileSize    uint64          `json:"totalFileSize"`
	Problems         []mirrorProblem `json:"problems"`
	ExcludedProblems uint64          `json:"excludedProblems"`
	Staging          *mirrorStaging  `json:"staging,omitempty"`
}

type mirrorProblem struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type mirrorStaging struct {
	Path          string `json:"path"`
	ReceivedFiles uint64 `json:"receivedFiles"`
	ExpectedFiles uint64 `json:"expectedFiles"`
	ReceivedSize  uint64 `json:"receivedSize"`
	ExpectedSize  uint64 `json:"expectedSize"`
}

type mirrorConflict struct {
	Root          string         `json:"root"`
	LocalChanges  []mirrorChange `json:"localChanges"`
	RemoteChanges []mirrorChange `json:"remoteChanges"`
}

type mirrorChange struct {
	Path string `json:"path"`
	// created, deleted or modified.
	Kind string `json:"kind"`
}

// Runs the daemon until `in` hits EOF or ctx is cancelled (the host
// closed the pipe, or sent SIGTERM), whichever comes first. Every
// request is served on its own goroutine (a create blocks on two
// endpoint connects), responses and state docs interleave on `out` one
// JSON line at a time. On the way out the context is cancelled BEFORE
// in-flight requests are awaited, so a create parked on a slow connect
// aborts instead of holding the exit for its full timeout, and the
// manager's shutdown halts every session before the process ends.
func runMirrorDaemon(ctx context.Context, in io.Reader, out io.Writer, gateway, dataDir string, logOut io.Writer) error {
	if gateway == "" {
		return errors.New("daemon needs --gateway <host:port>")
	}
	if dataDir == "" {
		return errors.New("daemon needs --data-dir <dir>")
	}
	if err := os.Setenv("MUTAGEN_DATA_DIRECTORY", dataDir); err != nil {
		return err
	}
	// Registered before the manager loads persisted sessions, which
	// start connecting immediately.
	synchronization.ProtocolHandlers[urlpkg.Protocol_SSH] = mirrorGatewayHandler{gateway: gateway}

	logger := logging.NewLogger(logging.LevelWarn, logOut)
	manager, err := synchronization.NewManager(logger)
	if err != nil {
		return fmt.Errorf("mirror manager: %w", err)
	}
	defer manager.Shutdown()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	emitter := &lineEmitter{w: out}
	emitter.emit(map[string]any{"event": "ready"})
	go streamMirrorState(ctx, manager, emitter)

	var pending sync.WaitGroup
	// The request reader runs on its own goroutine because a blocked
	// Scan cannot observe ctx: a SIGTERM must end the daemon even while
	// stdin stays open, and the reader is then simply abandoned (the
	// process is exiting).
	readerDone := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var req mirrorRequest
			if err := json.Unmarshal([]byte(line), &req); err != nil {
				emitter.emit(mirrorResponse{OK: false, Error: "malformed request: " + err.Error()})
				continue
			}
			if ctx.Err() != nil {
				break
			}
			pending.Add(1)
			go func() {
				defer pending.Done()
				emitter.emit(handleMirrorRequest(ctx, manager, req))
			}()
		}
		readerDone <- scanner.Err()
	}()
	var readErr error
	select {
	case readErr = <-readerDone:
	case <-ctx.Done():
	}
	cancel()
	pending.Wait()
	return readErr
}

func handleMirrorRequest(ctx context.Context, manager *synchronization.Manager, req mirrorRequest) mirrorResponse {
	respond := func(session string, err error) mirrorResponse {
		if err != nil {
			return mirrorResponse{ID: req.ID, OK: false, Error: err.Error()}
		}
		return mirrorResponse{ID: req.ID, OK: true, Session: session}
	}
	one := func() *selection.Selection {
		return &selection.Selection{Specifications: []string{req.Session}}
	}
	switch req.Op {
	case "create":
		id, err := createMirrorSession(ctx, manager, req)
		return respond(id, err)
	case "terminate":
		return respond(req.Session, manager.Terminate(ctx, one(), ""))
	case "pause":
		return respond(req.Session, manager.Pause(ctx, one(), ""))
	case "resume":
		return respond(req.Session, manager.Resume(ctx, one(), ""))
	default:
		return respond("", fmt.Errorf("unknown op %q", req.Op))
	}
}

func createMirrorSession(ctx context.Context, manager *synchronization.Manager, req mirrorRequest) (string, error) {
	switch {
	case req.LocalRoot == "":
		return "", errors.New("create needs localRoot")
	case req.DeviceID == "":
		return "", errors.New("create needs deviceId")
	case req.RemoteRoot == "":
		return "", errors.New("create needs remoteRoot")
	}
	if err := validateMirrorLabels(req.Labels); err != nil {
		return "", err
	}
	alpha := &urlpkg.URL{
		Kind:     urlpkg.Kind_Synchronization,
		Protocol: urlpkg.Protocol_Local,
		Path:     req.LocalRoot,
	}
	beta := &urlpkg.URL{
		Kind:     urlpkg.Kind_Synchronization,
		Protocol: urlpkg.Protocol_SSH,
		Host:     req.DeviceID,
		Path:     req.RemoteRoot,
		Parameters: map[string]string{
			mirrorParamProjectID:  req.ProjectID,
			mirrorParamWorktreeID: req.WorktreeID,
		},
	}
	// Two-way-safe: both sides write, a genuine conflict is reported
	// and left alone rather than resolved by guessing. The VCS ignore
	// keeps .git out (a linked worktree's .git is a file pointing at a
	// machine-specific gitdir, and the repo itself is git's to move),
	// nothing else is excluded by default, because the whole point is
	// that ignored files cross too.
	configuration := &synchronization.Configuration{
		SynchronizationMode: core.SynchronizationMode_SynchronizationModeTwoWaySafe,
		IgnoreVCSMode:       ignore.IgnoreVCSMode_IgnoreVCSModeIgnore,
		Ignores:             []string{mirrorGitPointerIgnore},
	}
	return manager.Create(
		ctx,
		alpha, beta,
		configuration, &synchronization.Configuration{}, &synchronization.Configuration{},
		mirrorSessionName(req.Name),
		req.Labels,
		false,
		"",
	)
}

// Labels face the same load-time check as names (a Kubernetes-style
// rule on keys and values), and Mutagen would drop a session whose
// labels fail it on the next start. Unlike the name, the labels carry
// identity (the app resolves its local project and worktree from
// them), so an invalid one is refused here, loudly, rather than
// rewritten into something the app could no longer resolve.
func validateMirrorLabels(labels map[string]string) error {
	for key, value := range labels {
		if err := selection.EnsureLabelKeyValid(key); err != nil {
			return fmt.Errorf("label %q: %w", key, err)
		}
		if err := selection.EnsureLabelValueValid(value); err != nil {
			return fmt.Errorf("label %q value %q: %w", key, value, err)
		}
	}
	return nil
}

// Mutagen session names may hold letters, digits and dashes, must
// start with a letter and must not be a UUID, and it checks that on
// LOAD as well as on create, so a name it accepted at creation but
// rejects at load (a branch name with a slash, say) makes the session
// vanish on the next daemon start. The app's name is descriptive only
// (the branch, while the labels carry the real identity), so it is folded
// into that alphabet here rather than trusted.
func mirrorSessionName(name string) string {
	var out []rune
	lastDash := false
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			out = append(out, r)
			lastDash = false
		case !lastDash && len(out) > 0:
			out = append(out, '-')
			lastDash = true
		}
	}
	for len(out) > 0 && out[len(out)-1] == '-' {
		out = out[:len(out)-1]
	}
	if len(out) == 0 {
		return ""
	}
	if !unicode.IsLetter(out[0]) {
		out = append([]rune("m-"), out...)
	}
	if len(out) > 64 {
		out = out[:64]
	}
	// Folding covers the alphabet. Mutagen also refuses a UUID-shaped
	// name and its reserved words, which a branch can legitimately be.
	// A prefix takes the name out of both sets.
	if selection.EnsureNameValid(string(out)) != nil {
		out = append([]rune("m-"), out...)
		if len(out) > 64 {
			out = out[:64]
		}
	}
	return string(out)
}

// Emits a state doc every time the manager's state index moves, until
// ctx ends. List blocks on the tracker, so this is push, not polling.
// The state index moves on every staging-progress update, not just
// per cycle, so the stream is throttled: at most one doc per
// mirrorStateMinInterval, and none when nothing the app reads
// changed (the projected doc is byte-identical to the last one).
const mirrorStateMinInterval = 200 * time.Millisecond

func streamMirrorState(ctx context.Context, manager *synchronization.Manager, emitter *lineEmitter) {
	var index uint64
	var last []byte
	var lastEmit time.Time
	for {
		next, states, err := manager.List(ctx, &selection.Selection{All: true}, index)
		if err != nil {
			if ctx.Err() == nil {
				emitter.emit(map[string]any{"event": "error", "error": err.Error()})
			}
			return
		}
		index = next
		doc := mirrorStateDoc{Event: "state", Index: index, Sessions: make([]mirrorSessionState, 0, len(states))}
		for _, state := range states {
			doc.Sessions = append(doc.Sessions, mirrorSessionStateOf(state))
		}
		// The index is left out of the comparison: it moves on every
		// tick and carries nothing the app reads.
		doc.Index = 0
		encoded, err := json.Marshal(doc)
		if err != nil {
			fmt.Fprintf(os.Stderr, "file-sync: json encode: %v\n", err)
			continue
		}
		if bytes.Equal(encoded, last) {
			continue
		}
		if wait := mirrorStateMinInterval - time.Since(lastEmit); wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		last = encoded
		lastEmit = time.Now()
		emitter.emitRaw(encoded)
	}
}

func mirrorSessionStateOf(state *synchronization.State) mirrorSessionState {
	session := state.Session
	labels := session.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	out := mirrorSessionState{
		Session:           session.Identifier,
		Name:              session.Name,
		Labels:            labels,
		LocalRoot:         session.Alpha.Path,
		DeviceID:          session.Beta.Host,
		ProjectID:         session.Beta.Parameters[mirrorParamProjectID],
		WorktreeID:        session.Beta.Parameters[mirrorParamWorktreeID],
		RemoteRoot:        session.Beta.Path,
		Paused:            session.Paused,
		Status:            mirrorStatusCode(state.Status),
		StatusText:        state.Status.Description(),
		LastError:         state.LastError,
		SuccessfulCycles:  state.SuccessfulCycles,
		Conflicts:         make([]mirrorConflict, 0, len(state.Conflicts)),
		ExcludedConflicts: state.ExcludedConflicts,
		Local:             mirrorEndpointStateOf(state.AlphaState),
		Remote:            mirrorEndpointStateOf(state.BetaState),
	}
	for _, conflict := range state.Conflicts {
		out.Conflicts = append(out.Conflicts, mirrorConflict{
			Root:          conflict.Root,
			LocalChanges:  mirrorChangesOf(conflict.AlphaChanges),
			RemoteChanges: mirrorChangesOf(conflict.BetaChanges),
		})
	}
	return out
}

func mirrorEndpointStateOf(state *synchronization.EndpointState) mirrorEndpointState {
	if state == nil {
		return mirrorEndpointState{Problems: []mirrorProblem{}}
	}
	out := mirrorEndpointState{
		Connected:        state.Connected,
		Scanned:          state.Scanned,
		Directories:      state.Directories,
		Files:            state.Files,
		SymbolicLinks:    state.SymbolicLinks,
		TotalFileSize:    state.TotalFileSize,
		Problems:         make([]mirrorProblem, 0, len(state.ScanProblems)+len(state.TransitionProblems)),
		ExcludedProblems: state.ExcludedScanProblems + state.ExcludedTransitionProblems,
	}
	for _, problem := range state.ScanProblems {
		out.Problems = append(out.Problems, mirrorProblem{Path: problem.Path, Error: problem.Error})
	}
	for _, problem := range state.TransitionProblems {
		out.Problems = append(out.Problems, mirrorProblem{Path: problem.Path, Error: problem.Error})
	}
	if progress := state.StagingProgress; progress != nil {
		out.Staging = &mirrorStaging{
			Path:          progress.Path,
			ReceivedFiles: progress.ReceivedFiles,
			ExpectedFiles: progress.ExpectedFiles,
			ReceivedSize:  progress.ReceivedSize,
			ExpectedSize:  progress.ExpectedSize,
		}
	}
	return out
}

func mirrorChangesOf(changes []*core.Change) []mirrorChange {
	out := make([]mirrorChange, 0, len(changes))
	for _, change := range changes {
		kind := "modified"
		switch {
		case change.Old == nil && change.New != nil:
			kind = "created"
		case change.Old != nil && change.New == nil:
			kind = "deleted"
		}
		out = append(out, mirrorChange{Path: change.Path, Kind: kind})
	}
	return out
}

// Mutagen's status enum as stable kebab-case codes, with alpha/beta
// translated to the local/remote vocabulary the app speaks.
func mirrorStatusCode(status synchronization.Status) string {
	switch status {
	case synchronization.Status_Disconnected:
		return "disconnected"
	case synchronization.Status_HaltedOnRootEmptied:
		return "halted-on-root-emptied"
	case synchronization.Status_HaltedOnRootDeletion:
		return "halted-on-root-deletion"
	case synchronization.Status_HaltedOnRootTypeChange:
		return "halted-on-root-type-change"
	case synchronization.Status_ConnectingAlpha:
		return "connecting-local"
	case synchronization.Status_ConnectingBeta:
		return "connecting-remote"
	case synchronization.Status_Watching:
		return "watching"
	case synchronization.Status_Scanning:
		return "scanning"
	case synchronization.Status_WaitingForRescan:
		return "waiting-for-rescan"
	case synchronization.Status_Reconciling:
		return "reconciling"
	case synchronization.Status_StagingAlpha:
		return "staging-local"
	case synchronization.Status_StagingBeta:
		return "staging-remote"
	case synchronization.Status_Transitioning:
		return "transitioning"
	case synchronization.Status_Saving:
		return "saving"
	default:
		return "unknown"
	}
}

// One JSON document per line, writes serialized: responses and state
// docs come from different goroutines and must never interleave
// mid-line.
type lineEmitter struct {
	mu sync.Mutex
	w  io.Writer
}

func (e *lineEmitter) emit(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "file-sync: json encode: %v\n", err)
		return
	}
	e.emitRaw(data)
}

func (e *lineEmitter) emitRaw(data []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Write(append(data, '\n'))
}
