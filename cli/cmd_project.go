package main

// sm projects <list|add|remove|config> -- manage registered projects
// without the app. `add` ports the app's projects:add handler
// (main/ipc/modules/projects.ts): git-repo check, duplicate-path
// check, uuid + basename identity, locked registry append, then a
// best-effort project.json seed (defaultBranch, plus a `<pm> install`
// setup script when the global autoPopulateInstall toggle is on).
// `config` rewrites only the fields it's given, preserving everything
// else the app may have written.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func cmdProject(ctx cliContext, args []string) (int, error) {
	if len(args) == 0 {
		out(namespaceHelp("projects"))
		return 0, nil
	}
	switch canonicalProjectsSub(args[0]) {
	case "list":
		return cmdProjectList(ctx)
	case "add":
		return cmdProjectAdd(ctx, args[1:])
	case "remove":
		return cmdProjectRemove(ctx, args[1:])
	case "config":
		return cmdConfig(ctx, args[1:])
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s projects <list|add|remove|config> [args]", args[0], binaryName)
	}
}

// Drops a project's registry entry under the state lock. missingOK is
// what separates the two callers: for `projects remove` a name that
// isn't registered is a user error, while doctor's repair races the app
// and must tolerate an entry that has already gone. The per-project
// state dir is removeProjectState's job -- the two callers disagree
// about what a failure there means.
func removeProjectRegistration(projectID string, missingOK bool) error {
	err := updateRegistryKey(projectsKey, func(raw json.RawMessage) (any, error) {
		var projects []project
		if err := decodeKey(registryPath(), projectsKey, raw, &projects); err != nil {
			if !missingOK {
				return nil, err
			}
			projects = nil
		}
		kept := make([]project, 0, len(projects))
		found := false
		for _, p := range projects {
			if p.ID == projectID {
				found = true
				continue
			}
			kept = append(kept, p)
		}
		if !found {
			if missingOK {
				return nil, nil
			}
			return nil, unknownProjectErr(projectID)
		}
		return kept, nil
	})
	return err
}

// The per-project state dir (config, shelved marks, worktree data),
// mirroring the app's deleteProjectState.
func removeProjectState(projectID string) error {
	return os.RemoveAll(projectDataDir(projectID))
}

// Ports the app's projects:remove: drop the registry entry and the
// per-project state dir (config, shelved marks, worktree data).
// Worktree checkouts stay on disk -- remove them first with `rm` if
// that's the intent. Unlike the app, the CLI can't reap scripts the
// app spawned into this project's worktrees; stop those in the app.
func cmdProjectRemove(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project-id": {}, // app plumbing: exact addressing from IPC
		},
		bools: map[string][]string{"yes": {"y"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	var proj project
	switch {
	case parsed.strings["project-id"] != "":
		proj, err = resolveProjectByID(ctx, parsed.strings["project-id"])
	case len(parsed.positionals) > 0:
		proj, err = resolveProject(ctx, parsed.positionals[0])
	case interactiveStdio():
		proj, err = pickProject(ctx, "")
	default:
		return 2, usageErrf("Specify a project to remove (see `%s projects list`).", binaryName)
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

	if err := removeProjectRegistration(proj.ID, false); err != nil {
		return exitCodeOf(err), err
	}
	// Best-effort, like the app's icon-cache cleanup: the entry is
	// already gone, so failing here would report a half-removal the
	// user can do nothing about.
	_ = removeProjectState(proj.ID)

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

// newRunID's format, uppercased. (The TS engine mints lowercase
// randomUUID ids, so the case incidentally records which engine
// registered a project.)
func newProjectID() string {
	return strings.ToUpper(newRunID())
}

func cmdProjectAdd(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		bools: map[string][]string{"all": {"a"}, "yes": {"y"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	rawPath := parsed.positional(0)
	if rawPath == "" {
		rawPath = "."
	}
	if parsed.bools["all"] {
		return cmdProjectAddAll(ctx, toAbsolute(rawPath), parsed.bools["yes"])
	}
	// Registering a subdirectory would break primary detection, so fold
	// whatever was given to the repo's PRIMARY checkout (the app's
	// folder picker hands over the root already; the CLI accepts `.`
	// from anywhere inside the repo). The common dir, not the toplevel:
	// from inside a linked worktree the toplevel is the worktree
	// directory, and registering that would leave a dangling project
	// when the worktree is removed.
	_, path, err := locateRepo(toAbsolute(rawPath))
	if err != nil {
		return 1, errf("%s is not a git repository", toAbsolute(rawPath))
	}

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
	err := updateRegistryKey(projectsKey, func(raw json.RawMessage) (any, error) {
		var projects []project
		if err := decodeKey(registryPath(), projectsKey, raw, &projects); err != nil {
			return nil, err
		}
		for _, existing := range projects {
			if existing.Path == path {
				return nil, errf("Project already added: %s", path)
			}
		}
		return append(projects, proj), nil
	})
	if err != nil {
		return project{}, err
	}
	return proj, nil
}

// Best-effort config seed; bare repos / unborn HEADs just stay
// unseeded until first configure (the scope's beforeWrite refuses to
// write a defaultBranch-less document, which vlogs below).
func seedProjectConfig(proj project) {
	seeded := map[string]any{}
	if defaultBranch := resolveDefaultBranch(proj.Path, ""); defaultBranch != "" {
		seeded["defaultBranch"] = defaultBranch
	}
	global := readGlobalConfigHints()
	if global.AutoPopulateInstall != nil && *global.AutoPopulateInstall {
		if pm := detectPackageManager(proj.Path); pm != "" {
			seeded["scripts.setup"] = pm + " install"
		}
	}
	if len(seeded) > 0 {
		err := projectConfigScope(proj).update(func(doc map[string]any) error {
			for key, value := range seeded {
				configDocSet(doc, key, value)
			}
			return nil
		})
		if err != nil {
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
		registered[p.Path] = true
	}
	var candidates []string
	known := 0
	for _, repo := range scanForGitRepos(root) {
		// Raw-path check first: registered rows were canonicalized at
		// registration, so a raw hit is already canonical and skips the
		// git spawn -- a re-run over an all-registered root then costs
		// no spawns at all.
		if registered[repo] {
			known++
			continue
		}
		// Fold the rest through git exactly like single add: the scan
		// built these paths from the caller's spelling of root, and a
		// mis-cased or symlinked spelling registered verbatim defeats
		// every later path lookup (resolveProjectByPath compares the
		// canonical spelling). Re-check after folding: the canonical
		// spelling may be the registered one even when the raw one
		// wasn't.
		if _, primaryPath, err := locateRepo(repo); err == nil {
			repo = primaryPath
		}
		if registered[repo] {
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
// host/lib/scripts/packageScripts.ts; "" when there's no package.json.
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

func cmdConfig(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project":        {"p"},
			"project-id":     {}, // app plumbing: exact addressing from IPC
			"setup":          {},
			"teardown":       {},
			"default-branch": {},
			"data":           {}, // app plumbing: `write` payload
		},
		bools: map[string][]string{
			"copy":    {}, // carryover add's mode pick
			"symlink": {},
		},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}

	legacyFlags := false
	for _, flag := range []string{"setup", "teardown", "default-branch"} {
		if _, ok := parsed.strings[flag]; ok {
			legacyFlags = true
		}
	}
	if len(parsed.positionals) > 0 {
		if legacyFlags {
			return 2, usageErrf("Use either the --setup/--teardown/--default-branch flags or a subcommand, not both.")
		}
		return cmdConfigVerb(proj, parsed)
	}

	// The long-standing flag shorthands, folded onto the key engine:
	// one locked write for all flags given, defaultBranch backfill via
	// the scope's beforeWrite.
	if v, ok := parsed.strings["default-branch"]; ok && strings.TrimSpace(v) == "" {
		// An empty defaultBranch makes the whole config invalid (the
		// schema requires it), which would silently drop every other
		// configured field on the next read. Refuse instead of "clear".
		return 2, usageErrf(
			"--default-branch can't be empty: it's required, so set a ref instead of clearing it.")
	}
	updates := map[string]string{}
	if v, ok := parsed.strings["default-branch"]; ok {
		updates["defaultBranch"] = v
	}
	for _, key := range []string{"setup", "teardown"} {
		if v, ok := parsed.strings[key]; ok {
			updates["scripts."+key] = v
		}
	}

	if len(updates) == 0 {
		// No updates: print the current config.
		raw, err := os.ReadFile(projectConfigJSONPath(proj.ID))
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

	err = projectConfigScope(proj).update(func(doc map[string]any) error {
		for name, value := range updates {
			if value == "" {
				// "" clears a script (an empty defaultBranch was refused
				// above).
				configDocDelete(doc, name)
			} else {
				configDocSet(doc, name, value)
			}
		}
		return nil
	})
	if err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "project": proj.Name})
	} else {
		out(greenOut("configured " + proj.Name))
	}
	return 0, nil
}

// The key-based verbs (`sm projects config set defaultBranch main`):
// the shared engine in cmd_config.go, differing from the global `sm
// config` only through the scope below.
func cmdConfigVerb(proj project, parsed parsedArgs) (int, error) {
	scope := projectConfigScope(proj)
	if handled, code, err := runSharedConfigVerb(scope, parsed); handled {
		return code, err
	}
	switch sub := parsed.positionals[0]; sub {
	case "carryover", "carry-over":
		return projectCarryOverVerb(proj, scope, parsed)
	case "edit":
		if _, err := os.Stat(scope.path); err != nil {
			// Seed through the engine so the required defaultBranch is
			// backfilled (locked, like every other write here) and a
			// hand-edited save doesn't start from a document the schema
			// rejects.
			if seedErr := scope.update(func(map[string]any) error { return nil }); seedErr != nil {
				return exitCodeOf(seedErr), seedErr
			}
		}
		return openConfigFileInEditor(scope.path)
	default:
		return 2, usageErrf(
			"Unknown subcommand %q. Usage: %s projects config <list|get|set|unset|edit|launcher|carryover> [args]",
			sub, binaryName)
	}
}

func projectConfigScope(proj project) configDocScope {
	return configDocScope{
		path:        projectConfigJSONPath(proj.ID),
		keys:        projectConfigKeys,
		usagePrefix: "projects config",
		usageSuffix: " [-p <project>]",
		suffix:      " for " + proj.Name,
		project:     proj.Name,
		beforeWrite: func(doc map[string]any) error { return ensureDefaultBranchField(doc, proj) },
		afterWrite:  func(doc map[string]any) { maybeExcludeInProjectDir(proj, doc) },
	}
}

// sm projects config carryover [add <path> [--copy|--symlink] | rm
// <path>] -- element verbs over the carryOver array. Paths are
// project-relative (absolute paths inside the project are folded);
// add upserts, so re-adding a path just switches its mode.
func projectCarryOverVerb(proj project, scope configDocScope, parsed parsedArgs) (int, error) {
	rest := parsed.positionals[1:]
	verb := "list"
	if len(rest) > 0 {
		verb = rest[0]
	}
	switch verb {
	case "list":
		entries, err := readConfigArray(scope.path, "carryOver")
		if err != nil {
			return exitCodeOf(err), err
		}
		if jsonMode {
			scope.emitOK(map[string]any{"carryOver": entries})
			return 0, nil
		}
		if len(entries) == 0 {
			note("No carry-over entries for " + proj.Name + ".")
			return 0, nil
		}
		var rows [][]string
		for _, entry := range entries {
			m, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			path, _ := m["path"].(string)
			mode, _ := m["mode"].(string)
			rows = append(rows, []string{path, mode})
		}
		out(renderTable([]string{"PATH", "MODE"}, rows))
		return 0, nil
	case "add":
		if len(rest) != 2 {
			return 2, scope.usageErr("carryover add <path> [--copy|--symlink]")
		}
		if parsed.bools["copy"] && parsed.bools["symlink"] {
			return 2, usageErrf("Pick one of --copy and --symlink.")
		}
		// symlink is the default: carry-over's headline use is sharing
		// gitignored state (env files, node_modules) across worktrees;
		// --copy snapshots instead.
		mode := "symlink"
		if parsed.bools["copy"] {
			mode = "copy"
		}
		path, err := normalizeCarryOverPath(proj, rest[1])
		if err != nil {
			return exitCodeOf(err), err
		}
		if _, statErr := os.Stat(filepath.Join(proj.Path, path)); statErr != nil {
			// Not fatal: gitignored sources may come and go, and the
			// entry only acts at worktree creation.
			note("warning: " + path + " doesn't currently exist in the primary checkout")
		}
		updated := false
		err = scope.update(func(doc map[string]any) error {
			entries, _ := doc["carryOver"].([]any)
			for _, entry := range entries {
				if m, ok := entry.(map[string]any); ok && m["path"] == path {
					m["mode"] = mode
					updated = true
				}
			}
			if !updated {
				entries = append(entries, map[string]any{"path": path, "mode": mode})
			}
			doc["carryOver"] = entries
			return nil
		})
		if err != nil {
			return 1, err
		}
		if jsonMode {
			scope.emitOK(map[string]any{"entry": map[string]any{"path": path, "mode": mode}})
			return 0, nil
		}
		verbed := "added"
		if updated {
			verbed = "updated"
		}
		out(greenOut(verbed + " carry-over " + path + " (" + mode + ")" + scope.suffix))
		return 0, nil
	case "rm", "remove":
		if len(rest) != 2 {
			return 2, scope.usageErr("carryover rm <path>")
		}
		path, err := normalizeCarryOverPath(proj, rest[1])
		if err != nil {
			return exitCodeOf(err), err
		}
		err = scope.update(func(doc map[string]any) error {
			entries, _ := doc["carryOver"].([]any)
			kept := make([]any, 0, len(entries))
			for _, entry := range entries {
				if m, ok := entry.(map[string]any); ok && m["path"] == path {
					continue
				}
				kept = append(kept, entry)
			}
			if len(kept) == len(entries) {
				return errf("No carry-over entry for %q.%s", path, scope.suffix)
			}
			setConfigList(doc, "carryOver", kept)
			return nil
		})
		if err != nil {
			return exitCodeOf(err), err
		}
		if jsonMode {
			scope.emitOK(map[string]any{"removed": path})
		} else {
			out(greenOut("removed carry-over " + path + scope.suffix))
		}
		return 0, nil
	default:
		return 2, scope.usageErr("carryover [add <path> [--copy|--symlink] | rm <path>]")
	}
}

// Folds whatever the user gave -- ./-prefixed, duplicated or trailing
// separators, or absolute-inside-the-project -- to one canonical
// project-relative forward-slash form, so the upsert and rm compares
// can't miss an existing entry over spelling. Applies the schema's
// stay-within-the-root refinement (isSafeRelPath).
func normalizeCarryOverPath(proj project, raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if filepath.IsAbs(p) {
		rel, err := filepath.Rel(proj.Path, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", usageErrf("%s is outside the project (%s).", p, proj.Path)
		}
		p = rel
	}
	if !isSafeRelPath(p) {
		return "", usageErrf("Carry-over paths must stay within the project root.")
	}
	// normalizeRelPath's separator fold plus dropping "." segments, so
	// ././x, ./x, and sub//dir all land on the same stored form.
	var parts []string
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg != "." {
			parts = append(parts, seg)
		}
	}
	if len(parts) == 0 {
		return "", usageErrf("Carry-over paths must stay within the project root.")
	}
	return strings.Join(parts, "/"), nil
}

// The zod schema requires defaultBranch, and the app's reader throws
// on a document missing it (readJsonOrNull is null only for a missing
// file) -- so backfill it from the repo, and when that fails (bare
// repo, unborn HEAD, moved path) refuse the write rather than land a
// file that breaks every shigomori:read for the project.
func ensureDefaultBranchField(doc map[string]any, proj project) error {
	if branch, ok := configDocGet(doc, "defaultBranch"); ok {
		if s, isString := branch.(string); isString && strings.TrimSpace(s) != "" {
			return nil
		}
	}
	if defaultBranch := resolveDefaultBranch(proj.Path, ""); defaultBranch != "" {
		configDocSet(doc, "defaultBranch", defaultBranch)
		return nil
	}
	return errf("Can't determine %s's default branch. Set it first: %s projects config set defaultBranch <ref> -p %s",
		proj.Name, binaryName, proj.Name)
}

// Hide `.shigomori/` from the primary's `git status` whenever the
// project opts into the in-project layout -- the same side effect the
// app's shigomori:write handler performs. Best-effort like the app's:
// appendExcludes skips lines that already exist and swallows failures.
func maybeExcludeInProjectDir(proj project, doc map[string]any) {
	if layout, _ := configDocGet(doc, "worktreeLayout"); layout == "in-project" {
		appendExcludes(proj.Path, []string{".shigomori"})
	}
}
