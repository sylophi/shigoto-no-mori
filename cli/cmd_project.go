package main

// sgm project add/list + sgm config -- register a repo without the app
// and set the per-project fields the golden loop uses. `add` ports the
// app's projects:add handler (main/ipc/modules/projects.ts): git-repo
// check, duplicate-path check, uuid + basename identity, locked state
// append, then a best-effort project.json seed (defaultBranch, plus a
// `<pm> install` setup script when the global autoPopulateInstall
// toggle is on). `config` rewrites only the fields it's given,
// preserving everything else the app may have written.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func cmdProject(ctx cliContext, args []string) (int, error) {
	if len(args) == 0 {
		return 2, usageErrf("Usage: %s project <list|add|remove> [args]", binaryName)
	}
	switch args[0] {
	case "list", "ls":
		return cmdProjectList(ctx)
	case "add":
		return cmdProjectAdd(ctx, args[1:])
	case "remove", "rm":
		return cmdProjectRemove(ctx, args[1:])
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s project <list|add|remove> [args]", args[0], binaryName)
	}
}

// Ports the app's projects:remove: drop the registry entry and the
// per-project state dir (config, shelved marks, worktree data).
// Worktree checkouts stay on disk -- remove them first with `rm` if
// that's the intent. Unlike the app, the CLI can't reap scripts the
// app spawned into this project's worktrees; stop those in the app.
func cmdProjectRemove(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		bools: map[string][]string{"yes": {"y"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	var proj project
	switch {
	case len(parsed.positionals) > 0:
		proj, err = resolveProject(ctx, parsed.positionals[0])
	case interactiveStdio():
		proj, err = pickProject(ctx)
	default:
		return 2, usageErrf("Specify a project to remove (see `%s project list`).", binaryName)
	}
	if err != nil {
		return exitCodeOf(err), err
	}

	remains := "No files are deleted from disk."
	if identities, idErr := listWorktreeIdentities(proj); idErr == nil {
		n := 0
		for _, id := range identities {
			if !id.IsPrimary {
				n++
			}
		}
		if n > 0 {
			remains = fmt.Sprintf("Its %d worktrees stay on disk.", n)
		}
	}
	if !parsed.bools["yes"] {
		if !interactiveStdio() {
			return 2, usageErrf(
				"Refusing to remove %s without confirmation. Re-run with --yes, or interactively.", proj.Name)
		}
		if !confirmPrompt(fmt.Sprintf("Remove %s (%s) from Shigoto no Mori? %s", proj.Name, proj.Path, remains)) {
			return 1, errf("Cancelled.")
		}
	}

	err = withStateLock(func() error {
		all := readStateFile()
		var projects []project
		if raw, ok := all["projects"]; ok {
			_ = json.Unmarshal(raw, &projects)
		}
		kept := make([]project, 0, len(projects))
		found := false
		for _, p := range projects {
			if p.ID == proj.ID {
				found = true
				continue
			}
			kept = append(kept, p)
		}
		if !found {
			return errf("Unknown project: %s", proj.ID)
		}
		encoded, err := json.Marshal(kept)
		if err != nil {
			return err
		}
		all["projects"] = encoded
		return atomicWriteJSON(statePath(), all)
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	// Mirrors the app's deleteProjectState; best-effort like the app's
	// icon-cache cleanup.
	_ = os.RemoveAll(filepath.Join(shigomoriRoot(), "projects", proj.ID))

	if jsonMode {
		emit(map[string]any{"ok": true, "removed": proj.Name, "path": proj.Path})
	} else {
		out("removed " + proj.Name + " (" + proj.Path + ")")
	}
	return 0, nil
}

func cmdProjectList(ctx cliContext) (int, error) {
	if jsonMode {
		projects := ctx.projects
		if projects == nil {
			projects = []project{}
		}
		emit(projects)
		return 0, nil
	}
	if len(ctx.projects) == 0 {
		note("No projects registered.")
		return 0, nil
	}
	rows := make([][]string, len(ctx.projects))
	for i, p := range ctx.projects {
		rows[i] = []string{p.Name, p.Path}
	}
	out(renderTable([]string{"NAME", "PATH"}, rows))
	return 0, nil
}

func newProjectID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	h := strings.ToUpper(hex.EncodeToString(b))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func cmdProjectAdd(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		bools: map[string][]string{"all": {"a"}, "yes": {"y"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	rawPath := "."
	if len(parsed.positionals) > 0 {
		rawPath = parsed.positionals[0]
	}
	if parsed.bools["all"] {
		return cmdProjectAddAll(ctx, toAbsolute(rawPath), parsed.bools["yes"])
	}
	// Registering a subdirectory would break primary detection, so fold
	// whatever was given to its repo toplevel (the app's folder picker
	// hands over the root already; the CLI accepts `.` from anywhere
	// inside the repo).
	toplevelRaw, err := runGit(toAbsolute(rawPath), "rev-parse", "--show-toplevel")
	if err != nil {
		return 1, errf("%s is not a git repository", toAbsolute(rawPath))
	}
	path := strings.TrimSpace(toplevelRaw)

	proj, err := registerProject(path)
	if err != nil {
		return exitCodeOf(err), err
	}
	seedProjectConfig(proj)

	if jsonMode {
		emit(proj)
	} else {
		out(greenOut(fmt.Sprintf("added %s (%s)", proj.Name, proj.Path)))
	}
	return 0, nil
}

// Registers a repo toplevel as a project. Duplicate check inside the
// locked update so two concurrent adds (app + CLI) of the same
// directory can't both land.
func registerProject(path string) (project, error) {
	proj := project{ID: newProjectID(), Name: filepath.Base(path), Path: path}
	err := withStateLock(func() error {
		all := readStateFile()
		var projects []project
		if raw, ok := all["projects"]; ok {
			_ = json.Unmarshal(raw, &projects)
		}
		for _, existing := range projects {
			if comparablePath(existing.Path) == comparablePath(path) {
				return errf("Project already added: %s", path)
			}
		}
		encoded, err := json.Marshal(append(projects, proj))
		if err != nil {
			return err
		}
		all["projects"] = encoded
		return atomicWriteJSON(statePath(), all)
	})
	if err != nil {
		return project{}, err
	}
	return proj, nil
}

// Best-effort config seed; bare repos / unborn HEADs just stay
// unseeded until first configure.
func seedProjectConfig(proj project) {
	seeded := map[string]any{}
	if defaultBranch := resolveDefaultBranch(proj.Path, ""); defaultBranch != "" {
		seeded["defaultBranch"] = defaultBranch
	}
	global := readGlobalConfig()
	if global.AutoPopulateInstall != nil && *global.AutoPopulateInstall {
		if pm := detectPackageManager(proj.Path); pm != "" {
			seeded["scripts"] = map[string]string{"setup": pm + " install"}
		}
	}
	if len(seeded) > 0 {
		if err := writeProjectConfigFields(proj.ID, seeded); err != nil {
			vlog("[project] config seed failed: %v", err)
		}
	}
}

// Mirrors the app's parent-folder scan (main/ipc/modules/fs.ts
// scanForGitRepos): outermost repos only, six levels deep, skipping
// hidden directories, symlinks, and directories that virtually never
// contain repos but are huge to walk.
var scanSkipDirs = map[string]bool{
	"node_modules": true,
	"target":       true,
	"dist":         true,
	"build":        true,
	"vendor":       true,
	"venv":         true,
	".venv":        true,
	"__pycache__":  true,
	".next":        true,
	".nuxt":        true,
	".turbo":       true,
	".cache":       true,
}

const scanMaxDepth = 6

func scanForGitRepos(root string) []string {
	var results []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > scanMaxDepth {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return // permission denied or vanished mid-scan
		}
		for _, e := range entries {
			// Outermost-only: a dir that is itself a repo is recorded and
			// not descended into. Worktree checkouts (.git file) don't
			// count, same as the app.
			if e.IsDir() && e.Name() == ".git" {
				results = append(results, dir)
				return
			}
		}
		for _, e := range entries {
			// DirEntry types come from lstat, so a symlinked dir reports
			// !IsDir and is skipped, matching the app.
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || scanSkipDirs[e.Name()] {
				continue
			}
			walk(filepath.Join(dir, e.Name()), depth+1)
		}
	}
	walk(root, 0)
	sort.Strings(results)
	return results
}

func cmdProjectAddAll(ctx cliContext, root string, yes bool) (int, error) {
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return 1, errf("%s is not a directory", root)
	}
	registered := make(map[string]bool, len(ctx.projects))
	for _, p := range ctx.projects {
		registered[comparablePath(p.Path)] = true
	}
	var candidates []string
	known := 0
	for _, repo := range scanForGitRepos(root) {
		if registered[comparablePath(repo)] {
			known++
			continue
		}
		candidates = append(candidates, repo)
	}
	if len(candidates) == 0 {
		suffix := ""
		if known > 0 {
			suffix = fmt.Sprintf(" (%d already registered)", known)
		}
		note(fmt.Sprintf("No new repos found under %s%s.", root, suffix))
		if jsonMode {
			emit([]project{})
		}
		return 0, nil
	}

	if !yes {
		if !interactiveStdio() {
			return 2, usageErrf(
				"Refusing to add %d projects without confirmation. Re-run with --yes, or interactively.",
				len(candidates))
		}
		note(fmt.Sprintf("Found %d new repos under %s:", len(candidates), root))
		note("")
		for _, repo := range candidates {
			note("  " + cyanErr(filepath.Base(repo)) + "  " + dimErr(repo))
		}
		note("")
		if known > 0 {
			note(dimErr(fmt.Sprintf("(%d already registered)", known)))
		}
		if !confirmPrompt(fmt.Sprintf("Add %d projects?", len(candidates))) {
			return 1, errf("Cancelled.")
		}
	}

	var added []project
	for _, repo := range candidates {
		proj, err := registerProject(repo)
		if err != nil {
			note(fmt.Sprintf("warning: skipping %s: %s", repo, err))
			continue
		}
		seedProjectConfig(proj)
		added = append(added, proj)
		if !jsonMode {
			out(greenOut(fmt.Sprintf("added %s (%s)", proj.Name, proj.Path)))
		}
	}
	if jsonMode {
		if added == nil {
			added = []project{}
		}
		emit(added)
	}
	return 0, nil
}

// Lockfile priority matches detectPackageManager in
// main/lib/scripts/packageScripts.ts; "" when there's no package.json.
func detectPackageManager(dir string) string {
	if _, err := os.Lstat(filepath.Join(dir, "package.json")); err != nil {
		return ""
	}
	for _, l := range []struct{ file, manager string }{
		{"bun.lockb", "bun"},
		{"bun.lock", "bun"},
		{"pnpm-lock.yaml", "pnpm"},
		{"yarn.lock", "yarn"},
	} {
		if _, err := os.Lstat(filepath.Join(dir, l.file)); err == nil {
			return l.manager
		}
	}
	return "npm"
}

// Merge the given fields into project.json without disturbing anything
// else the app wrote (carry-over entries, layout, merge method, ...).
func writeProjectConfigFields(projectID string, fields map[string]any) error {
	path := filepath.Join(shigomoriRoot(), "projects", projectID, "project.json")
	existing := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &existing)
	}
	for key, value := range fields {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		existing[key] = encoded
	}
	return atomicWriteJSON(path, existing)
}

func cmdConfig(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project":        {"p"},
			"setup":          {},
			"teardown":       {},
			"default-branch": {},
		},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, err := resolveProject(ctx, parsed.strings["project"])
	if err != nil {
		return exitCodeOf(err), err
	}

	fields := map[string]any{}
	if v, ok := parsed.strings["default-branch"]; ok {
		// An empty defaultBranch makes the whole config invalid (the
		// schema requires it), which would silently drop every other
		// configured field on the next read. Refuse instead of "clear".
		if strings.TrimSpace(v) == "" {
			return 2, usageErrf(
				"--default-branch can't be empty; it's required, so set a ref instead of clearing it.")
		}
		fields["defaultBranch"] = v
	}
	scriptUpdates := map[string]string{}
	for _, key := range []string{"setup", "teardown"} {
		if v, ok := parsed.strings[key]; ok {
			scriptUpdates[key] = v
		}
	}

	if len(fields) == 0 && len(scriptUpdates) == 0 {
		// No updates: print the current config.
		raw, err := os.ReadFile(filepath.Join(shigomoriRoot(), "projects", proj.ID, "project.json"))
		if jsonMode {
			if err != nil {
				emit(nil)
			} else {
				var parsed json.RawMessage = raw
				emit(parsed)
			}
			return 0, nil
		}
		if err != nil {
			note("No config for " + proj.Name + " yet.")
		} else {
			out(strings.TrimRight(string(raw), "\n"))
		}
		return 0, nil
	}

	if len(scriptUpdates) > 0 {
		// Scripts nest under one key; merge against the current object
		// so --setup doesn't wipe an existing teardown.
		current := map[string]string{}
		if config := readProjectConfig(proj.ID); config != nil {
			if config.Scripts.Setup != "" {
				current["setup"] = config.Scripts.Setup
			}
			if config.Scripts.Teardown != "" {
				current["teardown"] = config.Scripts.Teardown
			}
		}
		for key, value := range scriptUpdates {
			if value == "" {
				delete(current, key)
			} else {
				current[key] = value
			}
		}
		fields["scripts"] = current
	}

	// The zod schema requires defaultBranch; make sure a scripts-only
	// configure on an unseeded project doesn't produce a config the app
	// (and this CLI) would treat as absent.
	if _, ok := fields["defaultBranch"]; !ok && readProjectConfig(proj.ID) == nil {
		if defaultBranch := resolveDefaultBranch(proj.Path, ""); defaultBranch != "" {
			fields["defaultBranch"] = defaultBranch
		}
	}

	if err := writeProjectConfigFields(proj.ID, fields); err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "project": proj.Name})
	} else {
		out(greenOut("configured " + proj.Name))
	}
	return 0, nil
}
