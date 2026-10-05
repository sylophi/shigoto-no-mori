package main

// sm projects relocate [<name-or-path>] <new-path>: point a project at
// where its repo lives now, after it was moved or renamed by hand (the
// sidebar's "missing" projects). The registry entry keeps its id, so
// the per-project state (config, worktree data, the use log) carries
// over untouched, and what is keyed by the old path follows the new
// one: the primary checkout's path-derived id (marks, data file, a
// pending dirty capture), the manual order and the icon cache. `git
// worktree repair` then reconnects the linked worktrees to the moved
// repo, along with any that moved with it (inside it, the in-project
// layout, or beside it, with a parent folder moved whole). The one
// thing moved on disk: managed worktrees, whose folder is named after
// the repo's, follow a rename to where new worktrees go, so they don't
// turn external.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func cmdProjectRelocate(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project-id": {}, // app plumbing: exact addressing from IPC
		},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	// The new path is always the last positional, the project before it
	// optional (and none with --project-id), as in `worktrees move`.
	n := len(parsed.positionals)
	maxRefs := 1
	if parsed.strings["project-id"] != "" {
		maxRefs = 0
	}
	if n == 0 || n-1 > maxRefs {
		return 2, usageErrf("Usage: %s projects relocate [<name-or-path>] <new-path>", binaryName)
	}
	dest := toAbsolute(parsed.positionals[n-1])
	if n == 2 {
		parsed.strings["project"] = parsed.positionals[0]
	}
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	if proj.Source == "terrier" {
		return 1, errf(
			"%s is registered via terrier, not %s. Register its new path with terrier instead.",
			proj.Name, binaryName)
	}
	// Folded to the primary checkout like `projects add`, so pointing at
	// a subdirectory or a linked worktree still lands on the repo.
	_, path, err := locateRepo(dest)
	if err != nil {
		return 1, errf("%s is not a git repository", dest)
	}

	relocated, err := relocateProject(proj, path)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{
			"ok":      true,
			"project": buildProjectRows([]project{relocated}, false)[0],
		})
		return 0, nil
	}
	out(greenOut("relocated " + relocated.Name + " to " + relocated.Path))
	return 0, nil
}

// Repoints the registry entry and carries over what is keyed by the old
// path. A path equal to the current one is a no-op.
func relocateProject(proj project, path string) (project, error) {
	if path == proj.Path {
		return proj, nil
	}
	// Only for a repo that went: pointing a project that is still there
	// at another repo would hand that repo its config and marks, and
	// leave the real one's worktrees behind.
	if info, err := os.Stat(proj.Path); err == nil && info.IsDir() {
		return project{}, errf(
			"%s is still there. Relocate is for a repo that was moved or renamed by hand.", proj.Path)
	}
	// Terrier's rows are merged in by path, so either side being one
	// would put two projects in the list for one repo (and, when the
	// registry id was minted from the old path, two under one id).
	if terrierHasPath(proj.Path) {
		return project{}, errf(
			"terrier still lists %s. Run `terrier prune` first, then relocate.", proj.Path)
	}
	if terrierHasPath(path) {
		return project{}, errf(
			"%s is already a project, via terrier. Remove %s instead (`%s projects remove %s`).",
			path, proj.Name, binaryName, proj.Name)
	}
	// Named after its folder, as at registration: a repo renamed by hand
	// reads under its new name.
	relocated := project{ID: proj.ID, Name: filepath.Base(path), Path: path}
	err := updateRegistryKey(projectsKey, func(raw json.RawMessage) (any, error) {
		var projects []project
		if err := decodeKey(registryPath(), projectsKey, raw, &projects); err != nil {
			return nil, err
		}
		i := slices.IndexFunc(projects, func(p project) bool { return p.ID == proj.ID })
		if i < 0 {
			return nil, unknownProjectErr(proj.ID)
		}
		for _, other := range projects {
			if other.ID != proj.ID && other.Path == path {
				return nil, errf("%s is already registered as %s", path, other.Name)
			}
		}
		projects[i] = relocated
		return projects, nil
	})
	if err != nil {
		return project{}, err
	}

	// Everything below is best-effort: the entry already points at the
	// new path, and failing here would report a relocation that did
	// happen as one that didn't. The repair (relinkMovedWorktrees,
	// doctor's) also points every linked worktree back at the moved repo.
	moved := movedAlong(relocated, proj.Path)
	moved[proj.Path] = path
	if err := relinkMovedWorktrees(relocated, moved); err != nil {
		vlog("[relocate] worktree repair: %v", err)
	}
	rehomeManagedWorktrees(relocated, proj.Path)
	// In the project's own place, and only there: the new path may
	// already hold one (kept for a terrier row, say).
	editProjectOrder(proj.Path, func(order []string, i int) []string {
		kept := make([]string, 0, len(order))
		for j, p := range order {
			if j == i {
				kept = append(kept, path)
			} else if p != path {
				kept = append(kept, p)
			}
		}
		return kept
	})
	forgetIconCacheEntry(proj.Path)
	return relocated, nil
}

// The linked worktrees that moved along with the repo: git still lists
// them at a path that is gone, and they sit at the same place relative
// to the repo's new path. Inside the repo (the in-project layout), or
// beside it when a parent folder moved whole: each ancestor pair that
// still shares a name with its counterpart is tried, nearest first.
// Old path -> new path.
func movedAlong(proj project, oldPath string) map[string]string {
	moved := map[string]string{}
	stdout, err := runGit(proj.Path, "worktree", "list", "--porcelain")
	if err != nil {
		vlog("[relocate] worktree list: %v", err)
		return moved
	}
	type pair struct{ from, to string }
	pairs := []pair{{oldPath, proj.Path}}
	for from, to := oldPath, proj.Path; filepath.Base(from) == filepath.Base(to); {
		from, to = filepath.Dir(from), filepath.Dir(to)
		if from == to || from == filepath.Dir(from) {
			break
		}
		pairs = append(pairs, pair{from, to})
	}
	for _, entry := range parsePorcelain(stdout) {
		if _, err := os.Stat(entry.path); !errors.Is(err, os.ErrNotExist) {
			continue
		}
		for _, p := range pairs {
			rel, inside := strings.CutPrefix(entry.path, p.from+"/")
			if !inside {
				continue
			}
			candidate := filepath.Join(p.to, rel)
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				moved[entry.path] = candidate
				break
			}
		}
	}
	return moved
}

// The managed bases under the data dir and on the project's drive are
// named after the repo's folder, so a rename (or a move to another
// drive) would leave the managed worktrees reading as external. Each
// moves to where new worktrees go, as `worktrees move` would move it.
func rehomeManagedWorktrees(proj project, oldPath string) {
	config := readProjectConfig(proj.ID)
	oldBases := managedBasesFor(oldPath, config)
	newBases := managedBasesFor(proj.Path, config)
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		vlog("[relocate] worktree list: %v", err)
		return
	}
	base := resolveWorktreeBase(proj.Path, config)
	for _, id := range identities {
		if id.IsPrimary || !isManagedPath(id.Path, oldBases) || isManagedPath(id.Path, newBases) {
			continue
		}
		if _, err := os.Stat(id.Path); err != nil {
			continue
		}
		if _, err := moveWorktree(proj, id, filepath.Join(base, filepath.Base(id.Path))); err != nil {
			vlog("[relocate] move %s: %v", id.Path, err)
		}
	}
}
