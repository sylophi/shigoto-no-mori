package main

// Full worktree status objects -- the same shape the app's IPC returns
// (shared/schemas/worktree.ts WorktreeSchema) plus projectName, so
// --json consumers and the future app-as-CLI-caller read one format.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type worktreeJSON struct {
	ID            string          `json:"id"`
	ProjectID     string          `json:"projectId"`
	Name          string          `json:"name"`
	Branch        string          `json:"branch"`
	Path          string          `json:"path"`
	Ahead         int             `json:"ahead"`
	Behind        int             `json:"behind"`
	HasUpstream   bool            `json:"hasUpstream"`
	HasRemote     bool            `json:"hasRemote"`
	DivergedClean bool            `json:"divergedClean"`
	BehindPrimary int             `json:"behindPrimary"`
	PrimaryRef    string          `json:"primaryRef,omitempty"`
	ChangedCount  int             `json:"changedCount"`
	RecentCommits []commitSummary `json:"recentCommits"`
	IsPrimary     bool            `json:"isPrimary"`
	IsExternal    bool            `json:"isExternal"`
	Detached      bool            `json:"detached"`
	Shelved       bool            `json:"shelved"`
	ProjectName   string          `json:"projectName"`
}

const recentCommitsCount = 4

type buildContext struct {
	hasRemote  bool
	primaryRef string
	shelved    map[string]bool
}

func loadBuildContext(proj project) buildContext {
	config := readProjectConfig(proj.ID)
	override := ""
	if config != nil {
		override = config.DefaultBranch
	}
	return buildContext{
		hasRemote:  len(listRemotes(proj.Path)) > 0,
		primaryRef: resolveDefaultBranch(proj.Path, override),
		shelved:    readShelvedSet(),
	}
}

func buildWorktree(proj project, id worktreeIdentity, ctx buildContext) worktreeJSON {
	var (
		changed int
		commits []commitSummary
		rs      remoteSync
		behind  int
		wg      sync.WaitGroup
	)
	wg.Add(4)
	go func() { defer wg.Done(); changed = changedCount(id.Path) }()
	go func() { defer wg.Done(); commits = listCommits(id.Path, 0, recentCommitsCount) }()
	go func() { defer wg.Done(); rs = getRemoteSync(id.Path) }()
	go func() { defer wg.Done(); behind = behindPrimary(id, ctx.primaryRef) }()
	wg.Wait()
	return worktreeJSON{
		ID:            id.ID,
		ProjectID:     id.ProjectID,
		Name:          id.Name,
		Branch:        id.Branch,
		Path:          id.Path,
		Ahead:         rs.ahead,
		Behind:        rs.behind,
		HasUpstream:   rs.hasUpstream,
		HasRemote:     ctx.hasRemote,
		DivergedClean: rs.divergedClean,
		BehindPrimary: behind,
		PrimaryRef:    ctx.primaryRef,
		ChangedCount:  changed,
		RecentCommits: commits,
		IsPrimary:     id.IsPrimary,
		IsExternal:    id.IsExternal,
		Detached:      id.Detached,
		Shelved:       !id.IsPrimary && !id.IsExternal && ctx.shelved[id.ID],
	}
}

// Primary first, matching the app's sidebar ordering.
func listWorktrees(proj project) ([]worktreeJSON, error) {
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return nil, err
	}
	ctx := loadBuildContext(proj)
	ordered := make([]worktreeIdentity, 0, len(identities))
	for _, id := range identities {
		if id.IsPrimary {
			ordered = append(ordered, id)
		}
	}
	for _, id := range identities {
		if !id.IsPrimary {
			ordered = append(ordered, id)
		}
	}
	results := make([]worktreeJSON, len(ordered))
	var wg sync.WaitGroup
	for i, id := range ordered {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = buildWorktree(proj, id, ctx)
			results[i].ProjectName = proj.Name
		}()
	}
	wg.Wait()
	return results, nil
}

// createWorktree ports the createWorktree flow from
// main/lib/git/worktrees.ts: pick/validate the dirname, resolve the
// layout base, refresh the remote base ref, `git worktree add`, and
// re-read the identity so the returned branch is what git settled on.
// checkout=true reuses the existing branch `base` (no -b) -- the adopt
// path; otherwise a new branch is created (branchName, or the dirname).
func createWorktree(proj project, requestedName, branchName, base string, checkout bool) (worktreeJSON, error) {
	existing, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeJSON{}, err
	}
	used := map[string]bool{}
	for _, id := range existing {
		used[strings.ToLower(id.Name)] = true
	}
	if requestedName != "" && used[strings.ToLower(requestedName)] {
		return worktreeJSON{}, errf(
			`A worktree folder named "%s" already exists in this project.`, requestedName)
	}
	name := requestedName
	if name == "" {
		name = pickWorktreeName(used)
	}
	config := readProjectConfig(proj.ID)
	worktreePath := filepath.Join(resolveWorktreeBase(proj.Path, config), name)

	// Refresh the remote-tracking ref the new worktree will sit on so
	// the base isn't whatever the last fetch left behind.
	if base != "" && remoteRefExists(proj.Path, base) {
		if remote, branch := splitRemoteRef(base, listRemotes(proj.Path)); remote != "" {
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
		// No -b: reuse the existing branch. git refuses if it's already
		// checked out in another worktree. `--` keeps a base ref from
		// being parsed as flags.
		if _, err := runGit(proj.Path, "worktree", "add", "--", worktreePath, base); err != nil {
			return worktreeJSON{}, err
		}
	} else {
		branch := strings.TrimSpace(branchName)
		if branch == "" {
			branch = name
		}
		if err := gitWorktreeAdd(proj.Path, worktreePath, branch, base); err != nil {
			return worktreeJSON{}, err
		}
	}

	fresh, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeJSON{}, err
	}
	for _, id := range fresh {
		if comparablePath(id.Path) == comparablePath(worktreePath) {
			w := buildWorktree(proj, id, loadBuildContext(proj))
			w.ProjectName = proj.Name
			return w, nil
		}
	}
	return worktreeJSON{}, errors.New("worktree disappeared after creation")
}

// Force-remove with the ENOTEMPTY wipe fallback (removeWorktreeForce).
func removeWorktreeForce(projectPath, worktreePath string) error {
	err := gitWorktreeRemove(projectPath, worktreePath, true)
	if err == nil {
		return nil
	}
	msg := err.Error()
	if !strings.Contains(msg, "Directory not empty") && !strings.Contains(msg, "ENOTEMPTY") {
		return err
	}
	vlog("[worktrees] force-wipe fallback: %s", msg)
	if err := os.RemoveAll(worktreePath); err != nil {
		return err
	}
	pruneStaleWorktrees(projectPath)
	return nil
}
