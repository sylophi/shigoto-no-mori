package main

// The rules serve.go's header lists, held at the endpoint itself on both
// sides of a session: serve's side (serveMirrorEndpoint) and the
// daemon's own (guardedLocalHandler).

import (
	"context"
	"fmt"
	"maps"
	"path"
	"slices"
	"strings"

	"google.golang.org/protobuf/proto"

	"github.com/mutagen-io/mutagen/pkg/logging"
	"github.com/mutagen-io/mutagen/pkg/synchronization"
	"github.com/mutagen-io/mutagen/pkg/synchronization/core"
	"github.com/mutagen-io/mutagen/pkg/synchronization/rsync"
	urlpkg "github.com/mutagen-io/mutagen/pkg/url"
)

// A local endpoint that holds those rules on every call that names a
// path: a read through .git, at any depth, is refused, and a path staged
// or changed through one, a folder whose old or new contents hold one, a
// link into one, or a name this side can't keep is left out.
type guardedEndpoint struct {
	synchronization.Endpoint
}

func (e guardedEndpoint) Supply(paths []string, signatures []*rsync.Signature, receiver rsync.Receiver) error {
	if i := slices.IndexFunc(paths, touchesGit); i >= 0 {
		return fmt.Errorf("refused to read %q: .git is not synchronized", paths[i])
	}
	return e.Endpoint.Supply(paths, signatures, receiver)
}

// The paths left out are never staged: their changes come back as
// problems from Transition.
func (e guardedEndpoint) Stage(paths []string, digests [][]byte) ([]string, []*rsync.Signature, rsync.Receiver, error) {
	var allowedPaths []string
	var allowedDigests [][]byte
	for p, path := range paths {
		if !touchesGit(path) && unkeepablePath(path) == "" {
			allowedPaths = append(allowedPaths, path)
			allowedDigests = append(allowedDigests, digests[p])
		}
	}
	return e.Endpoint.Stage(allowedPaths, allowedDigests)
}

// The inner endpoint is called at most once: the local one refuses a
// second transition without a scan between.
func (e guardedEndpoint) Transition(ctx context.Context, transitions []*core.Change) ([]*core.Entry, []*core.Problem, bool, error) {
	results := make([]*core.Entry, len(transitions))
	var problems []*core.Problem
	var allowed []*core.Change
	var allowedAt []int
	for t, change := range transitions {
		var refusal string
		if touchesGit(change.Path) || holdsGit(change.Old) || holdsGit(change.New) || linksIntoGit(change.Path, change.New) {
			refusal = "touches .git, which is not synchronized"
		} else {
			refusal = unkeepablePath(change.Path)
		}
		if refusal != "" {
			results[t] = change.Old
			problems = append(problems, &core.Problem{Path: change.Path, Error: refusal})
			continue
		}
		// A folder keeps the rest of its contents. What it leaves out
		// comes again next cycle as a change of its own, refused above.
		if kept, left := keepable(change.Path, change.New); len(left) > 0 {
			change = &core.Change{Path: change.Path, Old: change.Old, New: kept}
			problems = append(problems, left...)
		}
		allowed = append(allowed, change)
		allowedAt = append(allowedAt, t)
	}
	if len(allowed) == 0 {
		return results, problems, false, nil
	}
	applied, appliedProblems, stagerMissingFiles, err := e.Endpoint.Transition(ctx, allowed)
	if err != nil {
		return nil, nil, false, err
	}
	for a, t := range allowedAt {
		results[t] = applied[a]
	}
	return results, append(problems, appliedProblems...), stagerMissingFiles, nil
}

func touchesGit(p string) bool {
	return p != "" && slices.ContainsFunc(strings.Split(path.Clean(p), "/"), isGitName)
}

// A name a volume reads as .git, held on every OS since the worktree
// may live on any of them: APFS and HFS+ fold case by default, so .GIT
// opens the same folder, and HFS+ also skips the code points it ignores
// in a name, so .g\u200cit does too (git's is_hfs_dotgit). NTFS drops
// trailing dots and spaces, reads what follows a colon as one of the
// folder's streams, and answers to the 8.3 short name, GIT~1 or a later
// digit when that one was taken (git's is_ntfs_dotgit, which checks
// ~1 alone).
func isGitName(name string) bool {
	name, _, _ = strings.Cut(strings.Map(hfsVisible, name), ":")
	name = strings.TrimRight(name, ". ")
	return strings.EqualFold(name, ".git") ||
		len(name) == 5 && strings.EqualFold(name[:4], "git~") && name[4] >= '1' && name[4] <= '9'
}

func hfsVisible(r rune) rune {
	switch {
	case r >= 0x200c && r <= 0x200f, r >= 0x202a && r <= 0x202e,
		r >= 0x206a && r <= 0x206f, r == 0xfeff:
		return -1
	}
	return r
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

// Why this side can't make p under p's own name (unkeepable), or "".
func unkeepablePath(p string) string {
	for _, name := range strings.Split(p, "/") {
		if refusal := unkeepable(name); refusal != "" {
			return refusal
		}
	}
	return ""
}

// The entry at `at` without the names this side can't keep, each left
// out as a problem. The entry given is never changed: the daemon's side
// passes its own.
func keepable(at string, entry *core.Entry) (*core.Entry, []*core.Problem) {
	var contents map[string]*core.Entry
	var left []*core.Problem
	for name, child := range entry.GetContents() {
		childPath := path.Join(at, name)
		if refusal := unkeepable(name); refusal != "" {
			left = append(left, &core.Problem{Path: childPath, Error: refusal})
			if contents == nil {
				contents = maps.Clone(entry.Contents)
			}
			delete(contents, name)
		} else if kept, childLeft := keepable(childPath, child); len(childLeft) > 0 {
			left = append(left, childLeft...)
			if contents == nil {
				contents = maps.Clone(entry.Contents)
			}
			contents[name] = kept
		}
	}
	if contents == nil {
		return entry, nil
	}
	return &core.Entry{Kind: entry.Kind, Contents: contents}, left
}

// What a side makes, files and folders, gets the modes a checkout gives
// them (umask 022). Mutagen's own defaults are owner-only, and its
// portable permissions carry only the executable bit across, which it
// adds for whoever may read.
const (
	madeFileMode      = 0o644
	madeDirectoryMode = 0o755
)

// The daemon's own side of each session, which applies what the peer's
// scan reports, holds .git as serve does: a peer's serve can be changed
// to report it. It makes files with a checkout's modes, as serve does,
// whatever the session was created with.
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
	made := proto.Clone(configuration).(*synchronization.Configuration)
	made.DefaultFileMode = madeFileMode
	made.DefaultDirectoryMode = madeDirectoryMode
	endpoint, err := h.ProtocolHandler.Connect(ctx, logger, url, prompter, session, version, made, alpha)
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
