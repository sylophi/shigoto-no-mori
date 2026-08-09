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
	"strings"
)

func cmdProject(ctx cliContext, args []string) (int, error) {
	if len(args) == 0 {
		return 2, usageErrf("Usage: %s project <list|add> [path]", binaryName)
	}
	switch args[0] {
	case "list", "ls":
		return cmdProjectList(ctx)
	case "add":
		return cmdProjectAdd(ctx, args[1:])
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s project <list|add> [path]", args[0], binaryName)
	}
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
	parsed, err := parseCmdArgs(args, argSpec{})
	if err != nil {
		return exitCodeOf(err), err
	}
	rawPath := "."
	if len(parsed.positionals) > 0 {
		rawPath = parsed.positionals[0]
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

	proj := project{ID: newProjectID(), Name: filepath.Base(path), Path: path}
	// Duplicate check inside the locked update so two concurrent adds
	// (app + CLI) of the same directory can't both land.
	err = withStateLock(func() error {
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
		return exitCodeOf(err), err
	}

	// Best-effort config seed; bare repos / unborn HEADs just stay
	// unseeded until first configure.
	seeded := map[string]any{}
	if defaultBranch := resolveDefaultBranch(path, ""); defaultBranch != "" {
		seeded["defaultBranch"] = defaultBranch
	}
	global := readGlobalConfig()
	if global.AutoPopulateInstall != nil && *global.AutoPopulateInstall {
		if pm := detectPackageManager(path); pm != "" {
			seeded["scripts"] = map[string]string{"setup": pm + " install"}
		}
	}
	if len(seeded) > 0 {
		if err := writeProjectConfigFields(proj.ID, seeded); err != nil {
			vlog("[project] config seed failed: %v", err)
		}
	}

	if jsonMode {
		emit(proj)
	} else {
		out(fmt.Sprintf("added %s (%s)", proj.Name, proj.Path))
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
		out("configured " + proj.Name)
	}
	return 0, nil
}
