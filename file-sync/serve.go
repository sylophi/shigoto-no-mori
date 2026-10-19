package main

// The peer side's endpoint server: Mutagen v0.18.1's own
// (pkg/synchronization/endpoint/remote/server.go, MIT, its request loop
// kept as it is), copied so the host decides what Mutagen leaves to the
// client. The client is a peer, and the stream it opened may reach the
// worktree the host opened it for and nothing more:
//
//   - the root is that worktree, whatever the client names;
//   - the session id, which Mutagen joins into the cache and staging
//     paths it writes and removes, must be an id Mutagen itself mints;
//   - staging happens in this serve's own data directory (--data-dir),
//     never beside the worktree or inside it;
//   - .git is never read or written, at any depth: its config can hold
//     credentials in a remote's URL, and git there would run what a peer
//     put in it (hooks, core.fsmonitor). The app's sessions ignore it on
//     both sides already, under the ignore syntax this side picks;
//   - links stay portable, and files and folders keep the modes this
//     side gives them.
//
// Mutagen's endpoint reads whatever paths the client names and applies
// whatever transitions it computed, so the .git rule is held at the
// endpoint itself (guardedEndpoint), on every call that names a path,
// not left to the configuration.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"google.golang.org/protobuf/proto"

	"github.com/mutagen-io/mutagen/pkg/encoding"
	"github.com/mutagen-io/mutagen/pkg/filesystem"
	"github.com/mutagen-io/mutagen/pkg/identifier"
	"github.com/mutagen-io/mutagen/pkg/logging"
	streampkg "github.com/mutagen-io/mutagen/pkg/stream"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"github.com/mutagen-io/mutagen/pkg/synchronization/compression"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
	"github.com/mutagen-io/mutagen/pkg/synchronization/endpoint/local"
	"github.com/mutagen-io/mutagen/pkg/synchronization/endpoint/remote"
	"github.com/mutagen-io/mutagen/pkg/synchronization/rsync"
	urlpkg "github.com/mutagen-io/mutagen/pkg/url"
)

// The buffering on each side of the stream, Mutagen's own for it.
const mirrorStreamBufferSize = 64 * 1024

// Serves one Mutagen endpoint at root over the stream until the client
// ends it, as remote.ServeEndpoint does, under the rules above. The
// stream must unblock reads and writes when closed (Mutagen's
// contract). Pipes and sockets do.
func serveMirrorEndpoint(stream io.ReadWriteCloser, root string, logOut io.Writer) error {
	algorithm, err := compression.ServerHandshake(stream)
	if err != nil {
		stream.Close()
		return fmt.Errorf("compression handshake failed: %w", err)
	}
	compressedInbound := bufio.NewReaderSize(stream, mirrorStreamBufferSize)
	decompressor := algorithm.Decompress(compressedInbound)
	inbound := bufio.NewReaderSize(decompressor, mirrorStreamBufferSize)
	compressedOutbound := bufio.NewWriterSize(stream, mirrorStreamBufferSize)
	compressor := algorithm.Compress(compressedOutbound)
	outbound := bufio.NewWriterSize(compressor, mirrorStreamBufferSize)
	flusher := streampkg.NewMultiFlusher(outbound, compressor, compressedOutbound)
	closer := streampkg.NewMultiCloser(
		streampkg.NewFlushCloser(outbound),
		compressor,
		streampkg.NewFlushCloser(compressedOutbound),
		stream,
		decompressor,
	)
	defer closer.Close()
	encoder := encoding.NewProtobufEncoder(outbound)
	decoder := encoding.NewProtobufDecoder(inbound)
	refuse := func(err error) error {
		encoder.Encode(&remote.InitializeSynchronizationResponse{Error: err.Error()})
		flusher.Flush()
		return err
	}

	request := &remote.InitializeSynchronizationRequest{}
	if err := decoder.Decode(request); err != nil {
		return refuse(fmt.Errorf("unable to receive initialize request: %w", err))
	}
	if !identifier.IsValid(request.Session) {
		return refuse(errors.New("invalid initialize request: not a session identifier"))
	}
	if !request.Version.Supported() {
		return refuse(errors.New("invalid initialize request: unsupported session version"))
	}
	configuration := servedConfiguration(request.Configuration)
	if err := configuration.EnsureValid(false); err != nil {
		return refuse(fmt.Errorf("invalid initialize request: invalid configuration: %w", err))
	}
	normalized, err := filesystem.Normalize(root)
	if err != nil {
		return refuse(fmt.Errorf("unable to normalize synchronization root: %w", err))
	}
	logger := logging.NewLogger(logging.LevelWarn, logOut)
	endpoint, err := local.NewEndpoint(
		logger,
		normalized,
		request.Session,
		request.Version,
		configuration,
		request.Alpha,
	)
	if err != nil {
		return refuse(fmt.Errorf("unable to create underlying endpoint: %w", err))
	}
	defer endpoint.Shutdown()
	if err = encoder.Encode(&remote.InitializeSynchronizationResponse{}); err != nil {
		return fmt.Errorf("unable to encode initialize response: %w", err)
	} else if err = flusher.Flush(); err != nil {
		return fmt.Errorf("unable to transmit initialize response: %w", err)
	}

	server := &endpointServer{
		endpoint: guardedEndpoint{endpoint},
		flusher:  flusher,
		encoder:  encoder,
		decoder:  decoder,
	}
	return server.serve()
}

// The client's configuration with what decides where this side reads
// and writes taken out of its hands. Its ignores stay, since they only
// narrow what crosses, with .git added to them.
func servedConfiguration(asked *synchronization.Configuration) *synchronization.Configuration {
	served := &synchronization.Configuration{}
	if asked != nil {
		served = proto.Clone(asked).(*synchronization.Configuration)
	}
	served.StageMode = synchronization.StageMode_StageModeMutagen
	served.IgnoreSyntax = ignore.Syntax_SyntaxMutagen
	served.IgnoreVCSMode = ignore.IgnoreVCSMode_IgnoreVCSModeIgnore
	served.Ignores = append(served.Ignores, mirrorGitPointerIgnore)
	served.SymbolicLinkMode = core.SymbolicLinkMode_SymbolicLinkModeDefault
	served.PermissionsMode = core.PermissionsMode_PermissionsModeDefault
	served.DefaultFileMode = 0
	served.DefaultDirectoryMode = 0
	served.DefaultOwner = ""
	served.DefaultGroup = ""
	return served
}

// A local endpoint that refuses any call touching .git, at any depth: a
// path read, staged or changed through one, or a folder whose old or new
// contents hold one.
type guardedEndpoint struct {
	synchronization.Endpoint
}

func (e guardedEndpoint) Supply(paths []string, signatures []*rsync.Signature, receiver rsync.Receiver) error {
	if err := refuseGitPaths("read", paths); err != nil {
		return err
	}
	return e.Endpoint.Supply(paths, signatures, receiver)
}

func (e guardedEndpoint) Stage(paths []string, digests [][]byte) ([]string, []*rsync.Signature, rsync.Receiver, error) {
	if err := refuseGitPaths("stage", paths); err != nil {
		return nil, nil, nil, err
	}
	return e.Endpoint.Stage(paths, digests)
}

// The daemon's own side of each session, which applies what the peer's
// scan reports, holds .git as serve does: a peer's serve can be changed
// to report it.
type guardedLocalHandler struct {
	synchronization.ProtocolHandler
}

func (h guardedLocalHandler) Connect(
	ctx context.Context,
	logger *logging.Logger,
	url *urlpkg.URL,
	prompter string,
	session string,
	version synchronization.Version,
	configuration *synchronization.Configuration,
	alpha bool,
) (synchronization.Endpoint, error) {
	endpoint, err := h.ProtocolHandler.Connect(ctx, logger, url, prompter, session, version, configuration, alpha)
	if err != nil {
		return nil, err
	}
	return guardedEndpoint{endpoint}, nil
}

// Once, before a session connects.
func holdGitOnLocalEndpoints() {
	local := synchronization.ProtocolHandlers[urlpkg.Protocol_Local]
	if _, held := local.(guardedLocalHandler); !held {
		synchronization.ProtocolHandlers[urlpkg.Protocol_Local] = guardedLocalHandler{local}
	}
}

func refuseGitPaths(verb string, paths []string) error {
	for _, p := range paths {
		if touchesGit(p) {
			return fmt.Errorf("refused to %s %q: .git is not synchronized", verb, p)
		}
	}
	return nil
}

func (e guardedEndpoint) Transition(ctx context.Context, transitions []*core.Change) ([]*core.Entry, []*core.Problem, bool, error) {
	for _, change := range transitions {
		if touchesGit(change.Path) || holdsGit(change.Old) || holdsGit(change.New) || linksIntoGit(change.Path, change.New) {
			return nil, nil, false, fmt.Errorf("refused a change to %q: .git is not synchronized", change.Path)
		}
	}
	return e.Endpoint.Transition(ctx, transitions)
}

func touchesGit(p string) bool {
	return p != "" && slicesContainsGit(strings.Split(path.Clean(p), "/"))
}

// A name the volume reads as .git: APFS and HFS+ fold case by default,
// so .GIT opens the same folder, and HFS+ also skips the code points it
// ignores in a name, so .g\u200cit does too (git's is_hfs_dotgit).
func isGitName(name string) bool {
	return strings.EqualFold(strings.Map(hfsVisible, name), ".git")
}

func hfsVisible(r rune) rune {
	switch {
	case r >= 0x200c && r <= 0x200f, r >= 0x202a && r <= 0x202e,
		r >= 0x206a && r <= 0x206f, r == 0xfeff:
		return -1
	}
	return r
}

func slicesContainsGit(components []string) bool {
	for _, component := range components {
		if isGitName(component) {
			return true
		}
	}
	return false
}

// A link this side would make that points into .git: Mutagen never
// follows one, but whatever here opens the worktree does (an editor,
// the files page, an agent writing through it).
func linksIntoGit(at string, entry *core.Entry) bool {
	if entry == nil {
		return false
	}
	if entry.Kind == core.EntryKind_SymbolicLink {
		return touchesGit(path.Join(path.Dir(at), entry.Target))
	}
	for name, child := range entry.Contents {
		if linksIntoGit(path.Join(at, name), child) {
			return true
		}
	}
	return false
}

func holdsGit(entry *core.Entry) bool {
	if entry == nil {
		return false
	}
	for name, child := range entry.Contents {
		if isGitName(name) || holdsGit(child) {
			return true
		}
	}
	return false
}

// --- Mutagen's endpoint server, as v0.18.1 has it ---

type endpointServer struct {
	endpoint synchronization.Endpoint
	flusher  streampkg.Flusher
	encoder  *encoding.ProtobufEncoder
	decoder  *encoding.ProtobufDecoder
}

func (s *endpointServer) encodeAndFlush(message proto.Message) error {
	if err := s.encoder.Encode(message); err != nil {
		return err
	} else if err = s.flusher.Flush(); err != nil {
		return fmt.Errorf("message transmission failed: %w", err)
	}
	return nil
}

func (s *endpointServer) serve() error {
	request := &remote.EndpointRequest{}
	for {
		*request = remote.EndpointRequest{}
		if err := s.decoder.Decode(request); err != nil {
			return fmt.Errorf("unable to receive request: %w", err)
		}
		var err error
		switch {
		case request.Poll != nil:
			err = s.servePoll()
		case request.Scan != nil:
			err = s.serveScan(request.Scan)
		case request.Stage != nil:
			err = s.serveStage(request.Stage)
		case request.Supply != nil:
			err = s.serveSupply(request.Supply)
		case request.Transition != nil:
			err = s.serveTransition(request.Transition)
		default:
			return errors.New("invalid request")
		}
		if err != nil {
			return err
		}
	}
}

// Runs `work` and sends what it answers, while a completion request
// from the client cancels it: Mutagen's shape for a poll, a scan and a
// transition. Both happen, in either order.
func (s *endpointServer) untilCompleted(
	completion proto.Message,
	work func(ctx context.Context) proto.Message,
) error {
	ctx, cancel := context.WithCancel(context.Background())
	received := make(chan error, 1)
	go func() {
		if err := s.decoder.Decode(completion); err != nil {
			received <- fmt.Errorf("unable to receive completion request: %w", err)
		} else {
			received <- nil
		}
	}()
	sent := make(chan error, 1)
	go func() {
		if err := s.encodeAndFlush(work(ctx)); err != nil {
			sent <- fmt.Errorf("unable to transmit response: %w", err)
		} else {
			sent <- nil
		}
	}()
	var sendErr, receiveErr error
	select {
	case receiveErr = <-received:
		cancel()
		sendErr = <-sent
	case sendErr = <-sent:
		cancel()
		receiveErr = <-received
	}
	if sendErr != nil {
		return sendErr
	}
	return receiveErr
}

func (s *endpointServer) servePoll() error {
	return s.untilCompleted(&remote.PollCompletionRequest{}, func(ctx context.Context) proto.Message {
		if err := s.endpoint.Poll(ctx); err != nil {
			return &remote.PollResponse{Error: err.Error()}
		}
		return &remote.PollResponse{}
	})
}

func (s *endpointServer) serveScan(request *remote.ScanRequest) error {
	if err := request.BaselineSnapshotSignature.EnsureValid(); err != nil {
		return fmt.Errorf("invalid scan request: %w", err)
	}
	return s.untilCompleted(&remote.ScanCompletionRequest{}, func(ctx context.Context) proto.Message {
		snapshot, err, tryAgain := s.endpoint.Scan(ctx, nil, request.Full)
		if err != nil {
			return &remote.ScanResponse{Error: err.Error(), TryAgain: tryAgain}
		}
		snapshotBytes, err := proto.MarshalOptions{Deterministic: true}.Marshal(snapshot)
		if err != nil {
			return &remote.ScanResponse{Error: fmt.Errorf("unable to marshal snapshot: %w", err).Error()}
		}
		return &remote.ScanResponse{
			SnapshotDelta: rsync.NewEngine().DeltifyBytes(snapshotBytes, request.BaselineSnapshotSignature, 0),
		}
	})
}

func (s *endpointServer) serveStage(request *remote.StageRequest) error {
	if len(request.Paths) == 0 || len(request.Digests) != len(request.Paths) {
		return errors.New("invalid stage request")
	}
	paths, signatures, receiver, err := s.endpoint.Stage(request.Paths, request.Digests)
	if err != nil {
		s.encodeAndFlush(&remote.StageResponse{Error: err.Error()})
		return fmt.Errorf("unable to begin staging: %w", err)
	}
	// Every path wanted is said as none listed, Mutagen's way of keeping
	// a first staging's answer small.
	responsePaths := paths
	if len(responsePaths) == len(request.Paths) {
		responsePaths = nil
	}
	if err = s.encodeAndFlush(&remote.StageResponse{Paths: responsePaths, Signatures: signatures}); err != nil {
		return fmt.Errorf("unable to send stage response: %w", err)
	}
	if len(paths) == 0 {
		return nil
	}
	if err = rsync.DecodeToReceiver(rsyncDecoder{s.decoder}, uint64(len(paths)), receiver); err != nil {
		return fmt.Errorf("unable to decode and forward rsync operations: %w", err)
	}
	return nil
}

func (s *endpointServer) serveSupply(request *remote.SupplyRequest) error {
	if len(request.Paths) != len(request.Signatures) {
		return errors.New("invalid supply request")
	}
	for _, signature := range request.Signatures {
		if err := signature.EnsureValid(); err != nil {
			return fmt.Errorf("invalid supply request: %w", err)
		}
	}
	receiver := rsync.NewEncodingReceiver(&rsyncEncoder{encoder: s.encoder, flusher: s.flusher})
	if err := s.endpoint.Supply(request.Paths, request.Signatures, receiver); err != nil {
		return fmt.Errorf("unable to perform supplying: %w", err)
	}
	return nil
}

func (s *endpointServer) serveTransition(request *remote.TransitionRequest) error {
	for _, change := range request.Transitions {
		if err := change.EnsureValid(true); err != nil {
			return fmt.Errorf("invalid transition request: %w", err)
		}
	}
	return s.untilCompleted(&remote.TransitionCompletionRequest{}, func(ctx context.Context) proto.Message {
		results, problems, stagerMissingFiles, err := s.endpoint.Transition(ctx, request.Transitions)
		if err != nil {
			return &remote.TransitionResponse{Error: err.Error()}
		}
		// Protocol Buffers can't carry a nil in a list, so each result
		// rides in an Archive.
		wrapped := make([]*core.Archive, len(results))
		for r, result := range results {
			wrapped[r] = &core.Archive{Content: result}
		}
		return &remote.TransitionResponse{
			Results:            wrapped,
			Problems:           problems,
			StagerMissingFiles: stagerMissingFiles,
		}
	})
}

type rsyncEncoder struct {
	encoder *encoding.ProtobufEncoder
	flusher streampkg.Flusher
	err     error
}

func (e *rsyncEncoder) Encode(transmission *rsync.Transmission) error {
	if e.err != nil {
		return fmt.Errorf("previous error encountered: %w", e.err)
	}
	e.err = e.encoder.Encode(transmission)
	return e.err
}

func (e *rsyncEncoder) Finalize() error {
	if e.err != nil {
		return nil
	}
	if err := e.flusher.Flush(); err != nil {
		return fmt.Errorf("unable to flush encoded messages: %w", err)
	}
	return nil
}

type rsyncDecoder struct {
	decoder *encoding.ProtobufDecoder
}

func (d rsyncDecoder) Decode(transmission *rsync.Transmission) error {
	return d.decoder.Decode(transmission)
}

func (d rsyncDecoder) Finalize() error {
	return nil
}
