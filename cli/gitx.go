package main

// Git plumbing, ported from host/lib/git/{core,worktrees,remotes,
// branches}.ts. One chokepoint (runGit) like the app's core.ts;
// everything downstream parses the same porcelain the app does so both
// surfaces describe worktrees identically.

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const unknownBranch = "(unknown)"

// Every git spawn passes through here, and `sm list` fans out over every
// project x every worktree x four probes -- unbounded, that is hundreds
// of processes and the time goes into fork/exec. runGit waits only on
// its own child, never on another slot, so a counting semaphore here
// caps the tree without deadlock.
var gitSlots = make(chan struct{}, max(4, runtime.NumCPU()))

func runGit(cwd string, args ...string) (string, error) {
	return runGitEnv(cwd, nil, args...)
}

// runGit with per-call extra environment entries appended to the
// inherited one (the dirty-state capture points GIT_INDEX_FILE at a
// temporary index). LC_ALL=C pins git's messages to English on every
// spawn: removeWorktreeForce matches "Directory not empty" on stderr,
// which gettext would otherwise translate. The TS twin pins it in
// host/lib/git/core.ts for the same reason.
func runGitEnv(cwd string, extraEnv []string, args ...string) (string, error) {
	gitSlots <- struct{}{}
	defer func() { <-gitSlots }()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.Env = append(append(os.Environ(), "LC_ALL=C"), extraEnv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	vlog("[git] %s (cwd %s)", strings.Join(args, " "), cwd)
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// --- worktree identities ---

type worktreeIdentity struct {
	ID         string
	ProjectID  string
	Name       string
	Branch     string
	Path       string
	IsPrimary  bool
	IsExternal bool
	Detached   bool
}

type porcelainEntry struct {
	path     string
	head     string
	branch   string
	bare     bool
	detached bool
}

func parsePorcelain(stdout string) []porcelainEntry {
	var entries []porcelainEntry
	var current porcelainEntry
	flush := func() {
		if current.path != "" {
			entries = append(entries, current)
		}
		current = porcelainEntry{}
	}
	for _, line := range strings.Split(stdout, "\n") {
		if line == "" {
			flush()
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			current.path = value
		case "HEAD":
			current.head = value
		case "branch":
			current.branch = value
		case "bare":
			current.bare = true
		case "detached":
			current.detached = true
		}
	}
	flush()
	return entries
}

func deriveBranch(e porcelainEntry) string {
	if e.branch != "" {
		return strings.TrimPrefix(e.branch, "refs/heads/")
	}
	if e.detached {
		if len(e.head) >= 7 {
			return e.head[:7]
		}
		return "detached"
	}
	return unknownBranch
}

// Memo for listWorktreeIdentities, keyed by project id. A CLI process
// resolves context, pickers, and command bodies against the same
// project within one run, and each un-memoized call costs a git spawn
// plus a project.json read. Every worktree mutation must call
// invalidateWorktreeIdentities before re-listing.
var (
	identityMemoMu sync.Mutex
	identityMemo   = map[string][]worktreeIdentity{}
)

func invalidateWorktreeIdentities(projectID string) {
	identityMemoMu.Lock()
	delete(identityMemo, projectID)
	identityMemoMu.Unlock()
}

// After a repair that can change any project's worktrees (doctor
// --fix), where re-listing one project at a time isn't enough.
func invalidateAllWorktreeIdentities() {
	identityMemoMu.Lock()
	clear(identityMemo)
	identityMemoMu.Unlock()
}

func listWorktreeIdentities(proj project) ([]worktreeIdentity, error) {
	identityMemoMu.Lock()
	cached, ok := identityMemo[proj.ID]
	identityMemoMu.Unlock()
	if ok {
		return cached, nil
	}
	identities, err := listWorktreeIdentitiesUncached(proj)
	if err != nil {
		return nil, err
	}
	identityMemoMu.Lock()
	identityMemo[proj.ID] = identities
	identityMemoMu.Unlock()
	return identities, nil
}

func listWorktreeIdentitiesUncached(proj project) ([]worktreeIdentity, error) {
	stdout, err := runGit(proj.Path, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	config := readProjectConfig(proj.ID)
	bases := managedBasesFor(proj.Path, config)
	var identities []worktreeIdentity
	index := 0
	for _, entry := range parsePorcelain(stdout) {
		if entry.bare {
			continue
		}
		isPrimary := entry.path == proj.Path || index == 0
		identities = append(identities, worktreeIdentity{
			ID:         worktreeIDFromPath(entry.path),
			ProjectID:  proj.ID,
			Name:       filepath.Base(entry.path),
			Branch:     deriveBranch(entry),
			Path:       entry.path,
			IsPrimary:  isPrimary,
			IsExternal: !isManagedPath(entry.path, bases),
			Detached:   entry.detached,
		})
		index++
	}
	return identities, nil
}

// --- status probes (buildWorktree parity) ---

// How many changed paths get stat'd for their mtime. Mirrors
// CHANGE_MTIME_STAT_LIMIT in host/lib/git/worktrees.ts.
const changeMtimeStatLimit = 64

type workingTreeChanges struct {
	count int
	// Newest mtime across the changed paths, epoch ms. Zero for a clean
	// worktree, and when every stat failed (an all-deletions diff).
	lastChangeAt int64
}

// One record of `git status --porcelain=v1 -z`: the index column, the
// worktree column, and the path. Callers that only want the path list
// go through parseStatusPaths.
type statusEntry struct {
	index    byte
	worktree byte
	path     string
}

// Splits `git status --porcelain=v1 -z` into the entries it reports.
// The -z form is what makes the paths usable: without it git C-quotes
// anything with a space or a non-ASCII byte. The cost is having to
// consume the rename/copy source, which git emits as a bare extra field
// right after the entry that renamed it.
func parseStatusEntries(stdout string) []statusEntry {
	fields := strings.Split(stdout, "\x00")
	var entries []statusEntry
	for i := 0; i < len(fields); i++ {
		field := fields[i]
		// Trailing empty field from the final NUL, and any short garbage:
		// every real record is "XY <path>", so at least 4 bytes.
		if len(field) < 4 {
			continue
		}
		entries = append(entries, statusEntry{index: field[0], worktree: field[1], path: field[3:]})
		// Either column can be the R/C -- staged renames land in the
		// index column, unstaged ones in the worktree column -- and both
		// emit exactly one source field.
		if isRenameOrCopy(field[0]) || isRenameOrCopy(field[1]) {
			i++
		}
	}
	return entries
}

func parseStatusPaths(stdout string) []string {
	return pathsOf(parseStatusEntries(stdout))
}

func pathsOf(entries []statusEntry) []string {
	if len(entries) == 0 {
		return nil
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		paths = append(paths, entry.path)
	}
	return paths
}

func isRenameOrCopy(column byte) bool {
	return column == 'R' || column == 'C'
}

// The error matters to callers guarding destructive operations: a
// worktree whose status can't be read (broken gitdir pointer,
// unreadable index) must NOT count as clean.
func getWorkingTreeChanges(worktreePath string) (workingTreeChanges, error) {
	paths, err := statusPaths(worktreePath)
	if err != nil {
		return workingTreeChanges{}, err
	}
	out := workingTreeChanges{count: len(paths)}
	// A deleted path stats as a failure, an untracked directory stats as
	// the directory -- both are fine, we only want the newest hit.
	for i, rel := range paths {
		if i >= changeMtimeStatLimit {
			break
		}
		info, statErr := os.Stat(filepath.Join(worktreePath, rel))
		if statErr != nil {
			continue
		}
		if ms := info.ModTime().UnixMilli(); ms > out.lastChangeAt {
			out.lastChangeAt = ms
		}
	}
	return out, nil
}

// Count only. The destructive-op guards just want "is it dirty", and
// the mtime scan getWorkingTreeChanges layers on top costs up to
// changeMtimeStatLimit stats they would throw away.
func changedCount(worktreePath string) (int, error) {
	paths, err := statusPaths(worktreePath)
	if err != nil {
		return 0, err
	}
	return len(paths), nil
}

// The one place the porcelain invocation and its parse live, so the
// display probes and the destructive-op guards can never read the
// working tree differently.
func statusEntries(worktreePath string) ([]statusEntry, error) {
	return porcelainStatus(worktreePath)
}

// statusEntries pinning --untracked-files=normal, for guards ahead of
// a working-tree overwrite (dirty apply): those must see untracked
// files even where the user configured `status.showUntrackedFiles no`,
// because the overwrite would destroy them (same rationale as
// overwriteFromUpstream in host/lib/git/sync.ts). statusEntries
// deliberately doesn't pin it -- `-uno` is a setting people choose to
// make the display probes cheap.
func statusEntriesUntracked(worktreePath string) ([]statusEntry, error) {
	return porcelainStatus(worktreePath, "--untracked-files=normal")
}

func porcelainStatus(worktreePath string, extra ...string) ([]statusEntry, error) {
	stdout, err := runGit(worktreePath, append([]string{"status", "--porcelain=v1", "-z"}, extra...)...)
	if err != nil {
		return nil, err
	}
	return parseStatusEntries(stdout), nil
}

func statusPaths(worktreePath string) ([]string, error) {
	entries, err := statusEntries(worktreePath)
	if err != nil {
		return nil, err
	}
	return pathsOf(entries), nil
}

type remoteSync struct {
	ahead, behind int
	hasUpstream   bool
	divergedClean bool
}

// `rev-list --left-right --count HEAD...<ref>` prints "<left>\t<right>":
// commits only on HEAD, then commits only on the ref. The one place
// that spawn and its parse live, so upstream sync, the primary
// relation, and the status card can never read a divergence
// differently. ok is false when the ref doesn't resolve here (a base
// branch that was never fetched, no upstream) or HEAD is unborn.
func aheadBehind(worktreePath, ref string) (ahead, behind int, ok bool) {
	if ref == "" {
		return 0, 0, false
	}
	stdout, err := runGit(worktreePath, "rev-list", "--left-right", "--count", "HEAD..."+ref)
	if err != nil {
		return 0, 0, false
	}
	fields := strings.Fields(strings.TrimSpace(stdout))
	if len(fields) < 2 {
		return 0, 0, false
	}
	ahead, _ = strconv.Atoi(fields[0])
	behind, _ = strconv.Atoi(fields[1])
	return ahead, behind, true
}

func getRemoteSync(worktreePath string) remoteSync {
	ahead, behind, ok := aheadBehind(worktreePath, "@{u}")
	if !ok {
		return remoteSync{}
	}
	rs := remoteSync{ahead: ahead, behind: behind, hasUpstream: true}
	if rs.ahead > 0 && rs.behind > 0 {
		if _, err := runGit(worktreePath, "merge-tree", "--write-tree", "HEAD", "@{u}"); err == nil {
			rs.divergedClean = true
		}
	}
	return rs
}

type commitSummary struct {
	Hash      string `json:"hash"`
	Subject   string `json:"subject"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

const logSentinel = "\x01"

var (
	insertionsRe = regexp.MustCompile(`(\d+) insertions?\(\+\)`)
	deletionsRe  = regexp.MustCompile(`(\d+) deletions?\(-\)`)
)

func listCommits(worktreePath string, skip, count int) []commitSummary {
	stdout, err := runGit(worktreePath,
		"log", fmt.Sprintf("--skip=%d", skip), fmt.Sprintf("-%d", count),
		"--pretty=format:"+logSentinel+"%h%x09%an%x09%aI%x09%s", "--shortstat")
	if err != nil {
		return []commitSummary{}
	}
	commits := []commitSummary{}
	for _, chunk := range strings.Split(stdout, logSentinel) {
		if chunk == "" {
			continue
		}
		header, stats, _ := strings.Cut(chunk, "\n")
		parts := strings.SplitN(header, "\t", 4)
		if len(parts) == 0 || parts[0] == "" {
			continue
		}
		c := commitSummary{Hash: parts[0]}
		if len(parts) > 1 {
			c.Author = parts[1]
		}
		if len(parts) > 2 {
			c.Date = parts[2]
		}
		if len(parts) > 3 {
			c.Subject = parts[3]
		}
		if m := insertionsRe.FindStringSubmatch(stats); m != nil {
			c.Additions, _ = strconv.Atoi(m[1])
		}
		if m := deletionsRe.FindStringSubmatch(stats); m != nil {
			c.Deletions, _ = strconv.Atoi(m[1])
		}
		commits = append(commits, c)
	}
	return commits
}

type primaryRelation struct {
	behindPrimary     int
	mergedIntoPrimary bool
}

// Ceiling on the first-parent walk in landedOnPrimary. Mirrors
// FIRST_PARENT_SCAN_LIMIT in host/lib/git/worktrees.ts.
const firstParentScanLimit = 2000

// Whether the branch's work is in the primary branch. See
// landedOnPrimary in host/lib/git/worktrees.ts for why this walks the
// primary's first-parent chain rather than asking `git branch --merged`,
// and which merge styles it deliberately reports as "not landed".
func landedOnPrimary(worktreePath string, behindPrimary int, chain *primaryChain) bool {
	if behindPrimary > firstParentScanLimit {
		return false
	}
	head, err := runGit(worktreePath, "rev-parse", "HEAD")
	if err != nil {
		return false
	}
	tip := strings.TrimSpace(head)
	if tip == "" {
		return false
	}
	commits, ok := chain.get()
	if !ok {
		return false
	}
	return !commits[tip]
}

// The primary's first-parent chain, read once per project and shared by
// every worktree in it -- one object store, one ref, one answer. Lazy,
// so a project whose worktrees are all ahead of the primary never asks.
// Mirrors primaryChainReader in host/lib/git/worktrees.ts.
type primaryChain struct {
	path string
	ref  string
	once sync.Once
	set  map[string]bool
	ok   bool
}

// The bool is "could we read it". False must be treated as "not landed":
// an empty set would report every HEAD as off the chain, i.e. merged.
func (c *primaryChain) get() (map[string]bool, bool) {
	c.once.Do(func() {
		if c.ref == "" {
			return
		}
		// firstParentScanLimit bounds how far behind a worktree can be
		// and still be asked about, so a chain that long covers every
		// HEAD that could sit on it.
		out, err := runGit(c.path, "rev-list", "--first-parent",
			fmt.Sprintf("-n%d", firstParentScanLimit+1), c.ref)
		if err != nil {
			return
		}
		set := map[string]bool{}
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			if line != "" {
				set[line] = true
			}
		}
		c.set, c.ok = set, true
	})
	return c.set, c.ok
}

// How the worktree sits against the project's primary branch. Both
// answers are "no relation" where the question doesn't apply (no
// primary, the primary worktree itself, detached HEAD).
func getPrimaryRelation(id worktreeIdentity, ctx buildContext) primaryRelation {
	if ctx.primaryRef == "" || id.IsPrimary || id.Detached {
		return primaryRelation{}
	}
	aheadOfPrimary, behindPrimary, ok := aheadBehind(id.Path, ctx.primaryRef)
	if !ok {
		return primaryRelation{}
	}
	// Anything HEAD still holds on its own hasn't landed yet, and a
	// branch level with the primary has nothing to have landed.
	if aheadOfPrimary > 0 || behindPrimary == 0 {
		return primaryRelation{behindPrimary: behindPrimary}
	}
	return primaryRelation{
		behindPrimary:     behindPrimary,
		mergedIntoPrimary: landedOnPrimary(id.Path, behindPrimary, ctx.chain),
	}
}

// --- remotes / default branch (remotes.ts parity) ---

func listRemotes(projectPath string) []string {
	stdout, err := runGit(projectPath, "remote")
	if err != nil {
		return nil
	}
	var remotes []string
	for _, line := range strings.Split(stdout, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			remotes = append(remotes, trimmed)
		}
	}
	return remotes
}

func refExists(projectPath, fullRef string) bool {
	_, err := runGit(projectPath, "show-ref", "--verify", "--quiet", fullRef)
	return err == nil
}

func localBranchExists(projectPath, branch string) bool {
	return refExists(projectPath, "refs/heads/"+branch)
}

func remoteRefExists(projectPath, ref string) bool {
	return refExists(projectPath, "refs/remotes/"+ref)
}

var defaultBranchCandidates = []string{"main", "master", "dev"}

// One for-each-ref spawn replaces the per-candidate show-ref probes:
// the full local + remote branch list is read once and every existence
// check happens in memory. Shared by both resolver variants below.
type branchRefScan struct {
	locals     []string // ref order, for resolveDefaultBranch's fallback
	localSet   map[string]bool
	remoteRefs map[string]bool
}

func scanBranchRefs(projectPath string) (branchRefScan, error) {
	stdout, err := runGit(projectPath, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return branchRefScan{}, err
	}
	scan := branchRefScan{localSet: map[string]bool{}, remoteRefs: map[string]bool{}}
	for _, line := range strings.Split(stdout, "\n") {
		ref := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(ref, "refs/heads/"):
			name := strings.TrimPrefix(ref, "refs/heads/")
			scan.locals = append(scan.locals, name)
			scan.localSet[name] = true
		case strings.HasPrefix(ref, "refs/remotes/"):
			scan.remoteRefs[strings.TrimPrefix(ref, "refs/remotes/")] = true
		}
	}
	return scan, nil
}

// Candidate remotes in the SAME precedence remoteKey applies in
// identity.go: upstream first, then origin, then the rest
// alphabetically. `git remote` prints alphabetically, so without this a
// remote sorting before "origin" would win the default-ref race, flip
// the root commit, and the two halves of identity would disagree about
// the canonical remote. Mirrors orderRemotesByPrecedence in
// shared/defaultBranch.mts.
func orderRemotesByPrecedence(remotes []string) []string {
	ordered := make([]string, 0, len(remotes))
	for _, name := range []string{"upstream", "origin"} {
		if slices.Contains(remotes, name) {
			ordered = append(ordered, name)
		}
	}
	var rest []string
	for _, name := range remotes {
		if name != "upstream" && name != "origin" {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	return append(ordered, rest...)
}

// Precedence shared with shared/defaultBranch.mts: a valid override
// wins, then each candidate remote-first in identity's remote
// precedence order. Fully qualified so a tag sharing a branch's name
// can't shadow it, and WITHOUT the first-local-branch fallback: ""
// means no default ref.
func pickDefaultRef(scan branchRefScan, override string, remotes []string) string {
	if trimmed := strings.TrimSpace(override); trimmed != "" {
		if scan.localSet[trimmed] {
			return "refs/heads/" + trimmed
		}
		if scan.remoteRefs[trimmed] {
			return "refs/remotes/" + trimmed
		}
	}
	orderedRemotes := orderRemotesByPrecedence(remotes)
	for _, candidate := range defaultBranchCandidates {
		for _, remote := range orderedRemotes {
			ref := remote + "/" + candidate
			if scan.remoteRefs[ref] {
				return "refs/remotes/" + ref
			}
		}
		if scan.localSet[candidate] {
			return "refs/heads/" + candidate
		}
	}
	return ""
}

// pickDefaultRef only yields these two namespaces, so a two-branch
// strip recovers exactly the short names ("main", "origin/main").
func shortRefName(fullRef string) string {
	if name, ok := strings.CutPrefix(fullRef, "refs/heads/"); ok {
		return name
	}
	return strings.TrimPrefix(fullRef, "refs/remotes/")
}

// Identity-facing variant, mirroring resolveDefaultRef in
// shared/defaultBranch.mts: "" with a nil error is semantic "no default
// ref". A scan failure propagates so identity can tell a broken git
// from a repo with no candidates.
func resolveDefaultRefWithRemotes(projectPath, override string, remotes []string) (string, error) {
	scan, err := scanBranchRefs(projectPath)
	if err != nil {
		return "", err
	}
	return pickDefaultRef(scan, override, remotes), nil
}

func resolveDefaultRef(projectPath, override string) (string, error) {
	return resolveDefaultRefWithRemotes(projectPath, override, listRemotes(projectPath))
}

// Short-name variant for merge-target callers, who additionally accept
// the first local branch as a last resort (a merge target only has to
// exist, while an identity must be stable across devices).
func resolveDefaultBranchWithRemotes(projectPath, override string, remotes []string) string {
	scan, err := scanBranchRefs(projectPath)
	if err != nil {
		return ""
	}
	if ref := pickDefaultRef(scan, override, remotes); ref != "" {
		return shortRefName(ref)
	}
	if len(scan.locals) > 0 {
		return scan.locals[0]
	}
	return ""
}

func resolveDefaultBranch(projectPath, override string) string {
	return resolveDefaultBranchWithRemotes(projectPath, override, listRemotes(projectPath))
}

// Longest-prefix split of "origin/main" into (remote, branch); nil-ish
// empty strings when no configured remote matches.
func splitRemoteRef(ref string, remotes []string) (string, string) {
	bestRemote, bestBranch := "", ""
	for _, remote := range remotes {
		prefix := remote + "/"
		if strings.HasPrefix(ref, prefix) && len(remote) > len(bestRemote) {
			bestRemote, bestBranch = remote, ref[len(prefix):]
		}
	}
	return bestRemote, bestBranch
}

// --- worktree mutation (worktrees.ts parity) ---

func gitWorktreeAdd(projectPath, worktreePath, branch, base string) error {
	args := []string{"worktree", "add", "-b", branch, "--", worktreePath}
	if base != "" {
		args = append(args, base)
	}
	_, err := runGit(projectPath, args...)
	return err
}

func gitWorktreeRemove(projectPath, worktreePath string, force bool) error {
	args := []string{"worktree", "remove", worktreePath}
	if force {
		args = append(args, "--force")
	}
	_, err := runGit(projectPath, args...)
	return err
}

func pruneStaleWorktrees(projectPath string) {
	_, _ = runGit(projectPath, "worktree", "prune")
}

// Force-delete policy honoring the app's toggle: never externals, skip
// placeholder branches, swallow failures (branch may be shared or be
// the primary's HEAD).
func deleteBranchAfterWorktreeRemoval(projectPath string, id worktreeIdentity, enabled bool) {
	if !enabled || id.IsExternal || id.Branch == unknownBranch {
		return
	}
	if _, err := runGit(projectPath, "branch", "-D", "--", id.Branch); err != nil {
		vlog("[git] branch delete skipped: %v", err)
	}
}
