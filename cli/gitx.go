package main

// Git plumbing, ported from main/lib/git/{core,worktrees,remotes,
// branches}.ts. One chokepoint (runGit) like the app's core.ts;
// everything downstream parses the same porcelain the app does so both
// surfaces describe worktrees identically.

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const unknownBranch = "(unknown)"

func runGit(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
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

// The error matters to callers guarding destructive operations: a
// worktree whose status can't be read (broken gitdir pointer,
// unreadable index) must NOT count as clean.
func changedCount(worktreePath string) (int, error) {
	stdout, err := runGit(worktreePath, "status", "--porcelain=v1")
	if err != nil {
		return 0, err
	}
	count := 0
	for _, line := range strings.Split(stdout, "\n") {
		if line != "" {
			count++
		}
	}
	return count, nil
}

type remoteSync struct {
	ahead, behind int
	hasUpstream   bool
	divergedClean bool
}

func getRemoteSync(worktreePath string) remoteSync {
	stdout, err := runGit(worktreePath, "rev-list", "--left-right", "--count", "HEAD...@{u}")
	if err != nil {
		return remoteSync{}
	}
	fields := strings.Fields(strings.TrimSpace(stdout))
	rs := remoteSync{hasUpstream: true}
	if len(fields) >= 2 {
		rs.ahead, _ = strconv.Atoi(fields[0])
		rs.behind, _ = strconv.Atoi(fields[1])
	}
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

func behindPrimary(id worktreeIdentity, primaryRef string) int {
	if primaryRef == "" || id.IsPrimary || id.Detached {
		return 0
	}
	stdout, err := runGit(id.Path, "rev-list", "--count", "HEAD.."+primaryRef)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(stdout))
	return n
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
// check happens in memory. Precedence matches remotes.ts: a valid
// override wins, then each candidate remote-first in `git remote`
// order, then the first local branch as a fallback.
func resolveDefaultBranchWithRemotes(projectPath, override string, remotes []string) string {
	stdout, err := runGit(projectPath, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return ""
	}
	var locals []string // ref order, for the first-branch fallback
	localSet := map[string]bool{}
	remoteRefs := map[string]bool{}
	for _, line := range strings.Split(stdout, "\n") {
		ref := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(ref, "refs/heads/"):
			name := strings.TrimPrefix(ref, "refs/heads/")
			locals = append(locals, name)
			localSet[name] = true
		case strings.HasPrefix(ref, "refs/remotes/"):
			remoteRefs[strings.TrimPrefix(ref, "refs/remotes/")] = true
		}
	}
	if trimmed := strings.TrimSpace(override); trimmed != "" {
		if localSet[trimmed] || remoteRefs[trimmed] {
			return trimmed
		}
	}
	for _, candidate := range defaultBranchCandidates {
		for _, remote := range remotes {
			ref := remote + "/" + candidate
			if remoteRefs[ref] {
				return ref
			}
		}
		if localSet[candidate] {
			return candidate
		}
	}
	if len(locals) > 0 {
		return locals[0]
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
