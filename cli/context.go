package main

// Invocation context: which registered project and worktree contain
// the cwd, plus the explicit name / project resolvers every command
// shares. cwd is only ever a default, never a requirement -- each
// command has an explicit form (-p, <project>/<name>) that works from
// anywhere.

import (
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

func resolveContext(cwd string) cliContext {
	ctx := cliContext{projects: loadProjects()}

	toplevelRaw, err := runGit(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return ctx
	}
	toplevel := strings.TrimSpace(toplevelRaw)

	// The common dir points at the primary repo's .git even from a
	// linked worktree -- one git call to identify the owning project.
	commonRaw, err := runGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return ctx
	}
	commonDir := strings.TrimSpace(commonRaw)
	primaryPath := commonDir
	if filepath.Base(commonDir) == ".git" {
		primaryPath = filepath.Dir(commonDir)
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

// Resolves `<name>`, `<project>/<name>`, or (with no ref) the worktree
// containing cwd. Unqualified names search every registered project
// and must be unambiguous.
func resolveWorktree(ctx cliContext, ref, projectFlag string) (located, error) {
	if ref == "" {
		if ctx.current != nil {
			return *ctx.current, nil
		}
		if ctx.unregisteredRepo != "" {
			return located{}, usageErrf(
				"This repo (%s) isn't registered as a project, so there is no worktree to target here. Pass a worktree name (see `%s list`).",
				ctx.unregisteredRepo, binaryName)
		}
		return located{}, usageErrf("Not inside a worktree; pass a worktree name (see `%s list`).", binaryName)
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
