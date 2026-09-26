package main

// Full worktree status objects: the row the app's WorktreeSchema
// (shared/schemas/worktree.ts) parses, plus projectName. The CLI owns
// this data model. The app reads rows through `sm worktrees list
// --json` (all, -p/--project-id, or one --worktree-id) instead of
// building its own, so a field added here is added for both surfaces.

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type worktreeJSON struct {
	ID                string          `json:"id"`
	ProjectID         string          `json:"projectId"`
	Name              string          `json:"name"`
	Branch            string          `json:"branch"`
	Path              string          `json:"path"`
	Ahead             int             `json:"ahead"`
	Behind            int             `json:"behind"`
	HasUpstream       bool            `json:"hasUpstream"`
	HasRemote         bool            `json:"hasRemote"`
	DivergedClean     bool            `json:"divergedClean"`
	BehindPrimary     int             `json:"behindPrimary"`
	UnpushedCount     int             `json:"unpushedCount"`
	PrimaryRef        string          `json:"primaryRef,omitempty"`
	PrimaryBranch     string          `json:"primaryBranch,omitempty"`
	MergedIntoPrimary bool            `json:"mergedIntoPrimary"`
	ChangedCount      int             `json:"changedCount"`
	LastChangeAt      int64           `json:"lastChangeAt,omitempty"`
	RecentCommits     []commitSummary `json:"recentCommits"`
	IsPrimary         bool            `json:"isPrimary"`
	IsExternal        bool            `json:"isExternal"`
	Detached          bool            `json:"detached"`
	Shelved           bool            `json:"shelved"`
	AutoPull          bool            `json:"autoPull"`
	ProjectName       string          `json:"projectName"`
}

const recentCommitsCount = 4

type buildContext struct {
	hasRemote  bool
	primaryRef string
	// The primary ref's local branch name ("main" for "origin/main"),
	// the branch a stack of pull requests lands on.
	primaryBranch string
	shelved       map[string]bool
	autoPull      map[string]bool
	// The shelf snapshots (shelf.go), read with the marks and only when
	// anything is shelved: nothing shelved, nothing to compare against.
	shelfSnapshots map[string]shelfSnapshot
	chain          *primaryChain
	// The project config the primary ref was resolved from, kept so
	// callers that need more of it don't read the file a second time.
	config *projectConfig
}

// The configured default-branch override, or "": the nil-config
// unwrap every default-branch resolver shares.
func defaultBranchOverride(config *projectConfig) string {
	if config == nil {
		return ""
	}
	return config.DefaultBranch
}

// The project's primary ref, honoring the configured override.
func primaryRefFor(proj project, config *projectConfig) string {
	return resolveDefaultBranch(proj.Path, defaultBranchOverride(config))
}

func loadBuildContext(proj project) buildContext {
	remotes, primaryRef, config := loadPrimaryRef(proj)
	return newBuildContext(proj, remotes, primaryRef, config)
}

// The project's primary ref, resolved once per project the way every
// row's is: the project config's default-branch override honored, and
// the remotes returned alongside (listRemotes feeds hasRemote, the
// default-branch resolution and the primary branch split; one spawn
// covers all three).
func loadPrimaryRef(proj project) (remotes []string, primaryRef string, config *projectConfig) {
	remotes = listRemotes(proj.Path)
	config = readProjectConfig(proj.ID)
	primaryRef = resolveDefaultBranchWithRemotes(proj.Path, defaultBranchOverride(config), remotes)
	return remotes, primaryRef, config
}

// The build context from project facts a caller already resolved
// (done and land hold the remotes and primary ref by then).
func newBuildContext(proj project, remotes []string, primaryRef string, config *projectConfig) buildContext {
	all := readRegistryHints()
	marks := worktreeMarkSetsFrom(all)
	ctx := buildContext{
		hasRemote:     len(remotes) > 0,
		primaryRef:    primaryRef,
		primaryBranch: primaryBranchOf(primaryRef, remotes),
		shelved:       marks[shelvedKey],
		autoPull:      marks[autoPullKey],
		chain:         &primaryChain{path: proj.Path, ref: primaryRef},
		config:        config,
	}
	if len(ctx.shelved) > 0 {
		ctx.shelfSnapshots = shelfSnapshotsFrom(all)
	}
	return ctx
}

// The local branch behind a primary ref: the ref minus its remote when
// it is a remote-tracking ref, the ref itself when it is local, "" when
// there is no primary ref.
func primaryBranchOf(primaryRef string, remotes []string) string {
	if remote, branch := splitRemoteRef(primaryRef, remotes); remote != "" {
		return branch
	}
	return primaryRef
}

// Only worktrees the app manages carry a shelved mark: the primary
// checkout and externals never do, and the two readers of the registry
// set must agree on that or a card and a row disagree.
func shelvedFlag(id worktreeIdentity, ctx buildContext) bool {
	return !id.IsPrimary && !id.IsExternal && ctx.shelved[id.ID]
}

// The identity fields of a full status object, for reusing helpers
// that take a worktreeIdentity when a worktreeJSON is already in hand.
func identityOf(w worktreeJSON) worktreeIdentity {
	return worktreeIdentity{
		ID: w.ID, ProjectID: w.ProjectID, Name: w.Name, Branch: w.Branch,
		Path: w.Path, IsPrimary: w.IsPrimary, IsExternal: w.IsExternal,
		Detached: w.Detached,
	}
}

func buildWorktree(proj project, id worktreeIdentity, ctx buildContext) worktreeJSON {
	row, _ := probeWorktree(proj, id, ctx)
	return row
}

// buildWorktree plus what the shelf needs of the probes (rowProbe).
func probeWorktree(proj project, id worktreeIdentity, ctx buildContext) (worktreeJSON, rowProbe) {
	var (
		changes   workingTreeChanges
		statusErr error
		commits   []commitSummary
		rs        remoteSync
		primary   primaryRelation
		unpushed  int
		wg        sync.WaitGroup
	)
	probe := rowProbe{at: time.Now().UnixMilli()}
	// Display probe: an unreadable status just shows as 0 changes (and
	// keeps the shelf from comparing the row).
	wg.Go(func() { changes, statusErr = getWorkingTreeChanges(id.Path) })
	wg.Go(func() { commits = listCommits(id.Path, 0, recentCommitsCount) })
	wg.Go(func() { rs = getRemoteSync(id.Path) })
	wg.Go(func() { primary = getPrimaryRelation(id, ctx) })
	wg.Go(func() { unpushed = getUnpushedCount(id.Path) })
	wg.Wait()
	probe.statusOK = statusErr == nil
	return worktreeJSON{
		ID:                id.ID,
		ProjectID:         id.ProjectID,
		Name:              id.Name,
		Branch:            id.Branch,
		Path:              id.Path,
		Ahead:             rs.ahead,
		Behind:            rs.behind,
		HasUpstream:       rs.hasUpstream,
		HasRemote:         ctx.hasRemote,
		DivergedClean:     rs.divergedClean,
		BehindPrimary:     primary.behindPrimary,
		UnpushedCount:     unpushed,
		PrimaryRef:        ctx.primaryRef,
		PrimaryBranch:     ctx.primaryBranch,
		MergedIntoPrimary: primary.mergedIntoPrimary,
		ChangedCount:      changes.count,
		LastChangeAt:      changes.lastChangeAt,
		RecentCommits:     commits,
		IsPrimary:         id.IsPrimary,
		IsExternal:        id.IsExternal,
		Detached:          id.Detached,
		Shelved:           shelvedFlag(id, ctx),
		// Unlike the shelf, any checkout can follow its upstream: the
		// primary is the mark's main customer.
		AutoPull:    ctx.autoPull[id.ID],
		ProjectName: proj.Name,
	}, probe
}

// A new slice holding the items first accepts, then the rest, each
// group in its original order. items itself is never reordered (the
// identity list is memoized).
func partitionStable[T any](items []T, first func(T) bool) []T {
	out := make([]T, 0, len(items))
	for _, item := range items {
		if first(item) {
			out = append(out, item)
		}
	}
	for _, item := range items {
		if !first(item) {
			out = append(out, item)
		}
	}
	return out
}

// Each row starts five git processes, and the app lists every project
// at once on a refresh, so the rows are built a few at a time: the cap
// costs a 30-row project no time (the probes are the bottleneck, not
// the fan-out) and keeps a refresh from forking hundreds of gits.
const rowProbeSlots = 6

// Primary first, matching the app's sidebar ordering. The full listing
// is what settles the shelf (settleShelves): a shelved row comes back
// unshelved once it has been worked in.
func listWorktrees(proj project) ([]worktreeJSON, error) {
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return nil, err
	}
	ctx := loadBuildContext(proj)
	ordered := partitionStable(identities, func(id worktreeIdentity) bool { return id.IsPrimary })
	results := make([]worktreeJSON, len(ordered))
	probes := make([]rowProbe, len(ordered))
	var wg sync.WaitGroup
	slots := make(chan struct{}, rowProbeSlots)
	for i, id := range ordered {
		wg.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			results[i], probes[i] = probeWorktree(proj, id, ctx)
		})
	}
	wg.Wait()
	settleShelves(results, probes, ctx)
	return results, nil
}

// createWorktree is the one worktree-creation flow (the app creates
// through `sm create`): pick/validate the dirname, resolve the layout
// base, refresh the remote base ref, `git worktree add`, and re-read
// the identity so the returned branch is what git settled on.
// checkout=true reuses the existing branch `base` (no -b) for the adopt
// path; otherwise a new branch is created (branchName, or the dirname).
func createWorktree(proj project, requestedName, branchName, base string, checkout bool) (worktreeJSON, error) {
	existing, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeJSON{}, err
	}
	used := worktreeNamesUsed(existing)
	if requestedName != "" && used[strings.ToLower(requestedName)] {
		return worktreeJSON{}, errf(
			`A worktree folder named "%s" already exists in this project.`, requestedName)
	}
	name := requestedName
	if name == "" {
		name = pickNewWorktreeName(proj, used)
	}
	config := readProjectConfig(proj.ID)
	worktreePath := filepath.Join(resolveWorktreeBase(proj.Path, config), name)

	// Refresh the remote-tracking ref the new worktree will sit on so
	// the base isn't whatever the last fetch left behind.
	var remotes []string
	if base != "" && remoteRefExists(proj.Path, base) {
		remotes = listRemotes(proj.Path)
		if remote, branch := splitRemoteRef(base, remotes); remote != "" {
			_, _ = runGit(proj.Path, "fetch", "--quiet", remote, branch)
		}
	}

	// The name-collision check above only sees THIS project's worktrees;
	// projects sharing a directory basename share a worktree base too
	// (layout keys on basename), so a sibling project's worktree can
	// occupy the path. Check the disk before git errors cryptically.
	if _, err := os.Lstat(worktreePath); err == nil {
		return worktreeJSON{}, errf(
			"Destination already exists: %s (another project with the same folder name may own it)",
			worktreePath)
	}

	if err := os.MkdirAll(filepath.Dir(worktreePath), 0o755); err != nil {
		return worktreeJSON{}, err
	}
	if checkout {
		if base == "" {
			return worktreeJSON{}, errf("Checkout mode requires a base ref")
		}
		// Reuse the existing branch (git refuses if it's already checked
		// out in another worktree), materializing a local tracking branch
		// when the base is a remote ref.
		if err := gitWorktreeCheckout(proj.Path, worktreePath, base, remotes); err != nil {
			return worktreeJSON{}, err
		}
	} else {
		branch := cmp.Or(strings.TrimSpace(branchName), name)
		if err := gitWorktreeAdd(proj.Path, worktreePath, branch, base); err != nil {
			return worktreeJSON{}, err
		}
	}

	invalidateWorktreeIdentities(proj.ID)
	fresh, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeJSON{}, err
	}
	for _, id := range fresh {
		if id.Path == worktreePath {
			return buildWorktree(proj, id, loadBuildContext(proj)), nil
		}
	}
	return worktreeJSON{}, errors.New("worktree disappeared after creation")
}

// The project's worktree folder names, lowercased: what a new folder
// name must not collide with (case-insensitively, since the default
// macOS volume is).
func worktreeNamesUsed(identities []worktreeIdentity) map[string]bool {
	used := make(map[string]bool, len(identities))
	for _, id := range identities {
		used[strings.ToLower(id.Name)] = true
	}
	return used
}

// A fresh folder name for a new worktree, the pick behind both `create`
// without a name and `worktrees destination`. The picked name doubles
// as the branch name, so names a kept local branch already holds (a
// removed worktree's, say) are skipped too. used is not modified.
func pickNewWorktreeName(proj project, used map[string]bool) string {
	used = maps.Clone(used)
	if scan, err := scanBranchRefs(proj.Path); err == nil {
		for _, branch := range scan.locals {
			used[strings.ToLower(branch)] = true
		}
	}
	return pickWorktreeName(used, doubutsuNamesEnabled(readGlobalConfigHints()))
}

// Test seam: the sweep failure below is a race, so tests stub git's
// end state instead of trying to hit the window.
var gitWorktreeRemoveFn = gitWorktreeRemove

// Removes the checkout through `git worktree remove`, finishing the
// sweep when git couldn't. Git checks the tree first (clean unless
// forced, unlocked, no submodules), then sweeps the directory, and it
// drops the admin entry under $GIT_DIR/worktrees whether or not the
// sweep finished. A sweep that stops short (a file landing between
// git's readdir and rmdir, typically from a watcher or a script winding
// down) therefore leaves a directory git no longer lists and no later
// `git worktree remove` can reach. The wipe takes only what git had
// already agreed to delete: it runs when the admin entry was there
// before and is gone after, which is exactly a sweep that started. A
// refusal keeps the entry and comes back unchanged. A wipe that fails
// comes back as an orphanedWorktreeError, since git's side is done and
// the caller's bookkeeping should follow.
func removeWorktreeDir(projectPath, worktreePath string, force bool) error {
	adminDir := worktreeAdminDir(worktreePath)
	err := gitWorktreeRemoveFn(projectPath, worktreePath, force)
	if err == nil {
		return nil
	}
	if adminDir == "" || !dirGone(adminDir) {
		return err
	}
	vlog("[worktrees] wipe fallback: %s", err)
	if wipeErr := wipeDir(worktreePath); wipeErr != nil {
		return &orphanedWorktreeError{path: worktreePath, git: err, wipe: wipeErr}
	}
	return nil
}

// A removal git finished on its side (the admin entry is gone) whose
// checkout is still on disk because the wipe failed.
type orphanedWorktreeError struct {
	path      string
	git, wipe error
}

func (e *orphanedWorktreeError) Error() string {
	return fmt.Sprintf("git no longer tracks %s as a worktree but couldn't finish deleting it (git: %v. wipe: %v). Delete the directory by hand.",
		e.path, e.git, e.wipe)
}

// The admin directory git keeps for a linked checkout, read from the
// checkout's own .git file ("gitdir: <dir>", relative to the checkout
// under worktree.useRelativePaths). Empty when the path isn't a linked
// worktree, which keeps the wipe away from any directory git never
// registered. Read from disk rather than `git worktree list` so the
// check costs no spawn and no path comparison against git's resolved
// spellings.
func worktreeAdminDir(worktreePath string) string {
	data, err := os.ReadFile(filepath.Join(worktreePath, ".git"))
	if err != nil {
		return ""
	}
	dir, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir: ")
	if !ok {
		return ""
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(worktreePath, dir)
	}
	return dir
}

// Only a definite "not there" counts: an unreadable admin dir must not
// pass for a finished sweep.
func dirGone(path string) bool {
	_, err := os.Stat(path)
	return errors.Is(err, fs.ErrNotExist)
}

// os.RemoveAll, retried for a few seconds while a directory keeps
// refilling: the writer that defeated git's sweep may still be landing
// files. No other error clears by waiting.
func wipeDir(path string) error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := os.RemoveAll(path)
		if err == nil || !errors.Is(err, syscall.ENOTEMPTY) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
}
