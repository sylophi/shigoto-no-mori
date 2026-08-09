package main

// Invocation context: which registered project and worktree contain
// the cwd, plus the explicit name / project resolvers every command
// shares. cwd is only ever a default, never a requirement -- each
// command has an explicit form (-p, <project>/<name>) that works from
// anywhere. The reserved names "root" and "primary" address a
// project's primary checkout.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type located struct {
	proj     project
	worktree worktreeIdentity
}

type cliContext struct {
	projects []project
	// Set when cwd sits inside a worktree git knows AND the repo is a
	// registered project. Covers the primary checkout too.
	current *located
	// Toplevel of the git repo containing cwd when that repo is NOT a
	// registered project.
	unregisteredRepo string
}

// One git spawn resolves both facts about a directory: the toplevel of
// the worktree containing it, and (via the common dir, which points at
// the primary repo's .git even from a linked worktree) the owning
// primary checkout.
func locateRepo(dir string) (toplevel, primaryPath string, err error) {
	stdout, err := runGit(dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
	if err != nil {
		return "", "", err
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) < 2 {
		return "", "", errf("unexpected rev-parse output")
	}
	toplevel = strings.TrimSpace(lines[0])
	commonDir := strings.TrimSpace(lines[1])
	primaryPath = commonDir
	if filepath.Base(commonDir) == ".git" {
		primaryPath = filepath.Dir(commonDir)
	}
	return toplevel, primaryPath, nil
}

func resolveContext(cwd string) cliContext {
	ctx := cliContext{projects: loadProjects()}

	toplevel, primaryPath, err := locateRepo(cwd)
	if err != nil {
		return ctx
	}

	for _, proj := range ctx.projects {
		if comparablePath(proj.Path) != comparablePath(primaryPath) {
			continue
		}
		identities, err := listWorktreeIdentities(proj)
		if err != nil {
			return ctx
		}
		for _, id := range identities {
			if comparablePath(id.Path) == comparablePath(toplevel) {
				ctx.current = &located{proj: proj, worktree: id}
				return ctx
			}
		}
		return ctx
	}
	ctx.unregisteredRepo = toplevel
	return ctx
}

// Context line above a project menu offered from inside a repo that
// isn't registered, so the jump to "pick a project" isn't mysterious.
func noteUnregistered(ctx cliContext) {
	if ctx.unregisteredRepo != "" {
		note(dimErr("This repo (" + ctx.unregisteredRepo + ") isn't a registered project."))
	}
}

func projectHint(ctx cliContext) string {
	if len(ctx.projects) == 0 {
		return "No projects are registered yet -- add the repo in the Shigoto no Mori app first."
	}
	names := make([]string, len(ctx.projects))
	for i, p := range ctx.projects {
		names[i] = p.Name
	}
	return "Registered projects: " + strings.Join(names, ", ") + "."
}

func resolveProject(ctx cliContext, name string) (project, error) {
	if name == "" {
		if ctx.current != nil {
			return ctx.current.proj, nil
		}
		// No project in cwd: a human gets the menu, scripts get the
		// explicit-forms error.
		if interactiveStdio() && len(ctx.projects) > 0 {
			noteUnregistered(ctx)
			return pickProject(ctx, "")
		}
		if ctx.unregisteredRepo != "" {
			return project{}, usageErrf(
				"This repo (%s) isn't registered as a project. Add it in the app, or target a project with -p. %s",
				ctx.unregisteredRepo, projectHint(ctx))
		}
		return project{}, usageErrf("Not inside a registered project; pass -p <project>. %s", projectHint(ctx))
	}
	var matches []project
	for _, p := range ctx.projects {
		if strings.EqualFold(p.Name, name) {
			matches = append(matches, p)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return project{}, usageErrf("Unknown project %q. %s", name, projectHint(ctx))
	default:
		paths := make([]string, len(matches))
		for i, p := range matches {
			paths[i] = p.Path
		}
		return project{}, usageErrf("Multiple projects are named %q: %s.", name, strings.Join(paths, ", "))
	}
}

func primaryOf(proj project) (located, error) {
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return located{}, err
	}
	for _, id := range identities {
		if id.IsPrimary {
			return located{proj: proj, worktree: id}, nil
		}
	}
	return located{}, errf("%s has no primary checkout.", proj.Name)
}

// nil/nil when ref isn't an existing directory (caller falls back to
// name resolution); an error when it is one but no registered project
// owns a worktree there.
func resolveWorktreeByDir(ctx cliContext, ref string) (*located, error) {
	abs := toAbsolute(ref)
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return nil, nil
	}
	// One git spawn identifies both the worktree toplevel (so any path
	// inside the checkout works) and the owning primary checkout, which
	// narrows the identity scan to the one project that can match.
	toplevel, primaryPath, gitErr := locateRepo(abs)
	if gitErr != nil {
		return nil, errf("%s isn't a worktree of any registered project.", abs)
	}
	for _, proj := range ctx.projects {
		if comparablePath(proj.Path) != comparablePath(primaryPath) {
			continue
		}
		identities, idErr := listWorktreeIdentities(proj)
		if idErr != nil {
			continue
		}
		for _, id := range identities {
			if comparablePath(id.Path) == comparablePath(toplevel) {
				return &located{proj: proj, worktree: id}, nil
			}
		}
	}
	return nil, errf("%s isn't a worktree of any registered project.", abs)
}

// App plumbing: exact addressing by the ids the app's IPC layer holds.
// The --json error document carries a stable code ("unknown-project" /
// "unknown-worktree") that the delegate maps onto shared/errors.ts's
// entity-gone constructors, so neither side's prose is load-bearing.
func unknownProjectErr(id string) error {
	return codedErrf("unknown-project", "Unknown project: %s", id)
}

func unknownWorktreeErr(id string) error {
	return codedErrf("unknown-worktree", "Unknown worktree: %s", id)
}

func resolveProjectByID(ctx cliContext, id string) (project, error) {
	for _, p := range ctx.projects {
		if p.ID == id {
			return p, nil
		}
	}
	return project{}, unknownProjectErr(id)
}

func resolveWorktreeByID(ctx cliContext, projectID, worktreeID string) (located, error) {
	scope := ctx.projects
	if projectID != "" {
		proj, err := resolveProjectByID(ctx, projectID)
		if err != nil {
			return located{}, err
		}
		scope = []project{proj}
	}
	for _, proj := range scope {
		identities, err := listWorktreeIdentities(proj)
		if err != nil {
			continue
		}
		for _, id := range identities {
			if id.ID == worktreeID {
				return located{proj: proj, worktree: id}, nil
			}
		}
	}
	return located{}, unknownWorktreeErr(worktreeID)
}

// Shared front door for commands that target a worktree: --worktree-id
// (with optional --project-id scoping) wins, then the positional
// name/<project>/<name> forms, then cwd. primaryOK declares whether
// the command can act on the primary checkout; it only shapes the
// pickers -- explicit refs resolve either way so commands that refuse
// the primary get to say so themselves.
func resolveWorktreeArgs(ctx cliContext, parsed parsedArgs, primaryOK bool) (located, error) {
	if wid := parsed.strings["worktree-id"]; wid != "" {
		return resolveWorktreeByID(ctx, parsed.strings["project-id"], wid)
	}
	ref := ""
	if len(parsed.positionals) > 0 {
		ref = parsed.positionals[0]
	}
	return resolveWorktree(ctx, ref, parsed.strings["project"], primaryOK)
}

// Same front door for commands that target a project.
func resolveProjectArgs(ctx cliContext, parsed parsedArgs) (project, error) {
	if pid := parsed.strings["project-id"]; pid != "" {
		return resolveProjectByID(ctx, pid)
	}
	return resolveProject(ctx, parsed.strings["project"])
}

// Resolves `<name>`, `<project>/<name>`, or (with no ref) the worktree
// containing cwd. Unqualified names search every registered project
// and must be unambiguous. Reserved names (isPrimaryKeyword) resolve
// to the primary checkout before any worktree name is considered.
func resolveWorktree(ctx cliContext, ref, projectFlag string, primaryOK bool) (located, error) {
	if ref == "" {
		if ctx.current != nil {
			// From the primary checkout, silently acting on it surprises
			// more than a menu: offer the project's worktrees when a human
			// is on the other end -- with the primary itself on the menu
			// when the command can act on it. Agents, pipelines, and
			// --json keep the deterministic primary.
			if ctx.current.worktree.IsPrimary && interactiveStdio() {
				return pickWorktree(ctx.current.proj, "", primaryOK)
			}
			return *ctx.current, nil
		}
		// No worktree in cwd: a human gets project menu then worktree
		// menu, scripts get the explicit-forms error.
		if interactiveStdio() && len(ctx.projects) > 0 {
			noteUnregistered(ctx)
			proj, err := pickProject(ctx, "")
			if err != nil {
				return located{}, err
			}
			return pickWorktree(proj, "", primaryOK)
		}
		if ctx.unregisteredRepo != "" {
			return located{}, usageErrf(
				"This repo (%s) isn't registered as a project, so there is no worktree to target here. Pass a worktree name (see `%s list`).",
				ctx.unregisteredRepo, binaryName)
		}
		return located{}, usageErrf("Not inside a worktree; pass a worktree name (see `%s list`).", binaryName)
	}

	// A ref that names an existing directory resolves by identity, not
	// name, so external worktrees with colliding basenames stay
	// addressable: `sm adopt ../checkouts/fox`, `sm rm .`. A
	// <project>/<name> ref almost never exists as a directory relative
	// to cwd; when it does, the directory wins as the more explicit
	// claim.
	if strings.ContainsAny(ref, `/\`) || ref == "." || ref == ".." {
		target, err := resolveWorktreeByDir(ctx, ref)
		if err != nil {
			return located{}, err
		}
		if target != nil {
			return *target, nil
		}
	}

	scope := ctx.projects
	name := ref
	if projectFlag != "" {
		proj, err := resolveProject(ctx, projectFlag)
		if err != nil {
			return located{}, err
		}
		scope = []project{proj}
	} else if cut := strings.Index(ref, "/"); cut >= 0 {
		proj, err := resolveProject(ctx, ref[:cut])
		if err != nil {
			return located{}, err
		}
		scope = []project{proj}
		name = ref[cut+1:]
	}

	// Reserved forms beat the name scan: a narrowed scope answers
	// directly, an unqualified keyword prefers the project containing
	// cwd.
	if isPrimaryKeyword(name) {
		switch {
		case len(scope) == 1:
			return primaryOf(scope[0])
		case ctx.current != nil:
			return primaryOf(ctx.current.proj)
		case len(scope) > 1:
			return located{}, usageErrf(
				"%q needs a project when outside one -- use <project>/%s or -p <project>.", name, name)
		}
	}

	var (
		matches []located
		mu      sync.Mutex
		wg      sync.WaitGroup
	)
	for _, proj := range scope {
		wg.Add(1)
		go func() {
			defer wg.Done()
			identities, err := listWorktreeIdentities(proj)
			if err != nil {
				return // missing/broken repo; other projects can still match
			}
			for _, id := range identities {
				if strings.EqualFold(id.Name, name) {
					mu.Lock()
					matches = append(matches, located{proj: proj, worktree: id})
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()

	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		where := ""
		if len(scope) == 1 {
			where = " in project " + scope[0].Name
		}
		return located{}, errf("No worktree named %q%s.", name, where)
	default:
		candidates := make([]string, len(matches))
		for i, m := range matches {
			candidates[i] = m.proj.Name + "/" + m.worktree.Name
		}
		return located{}, usageErrf("%q is ambiguous (%s) -- qualify it as <project>/<name>.",
			name, strings.Join(candidates, ", "))
	}
}
