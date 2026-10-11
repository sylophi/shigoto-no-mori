package main

// sm run: run (or list) the scripts of the worktree containing the
// cwd: its package.json scripts, justfile recipes and Makefile targets
// (script_files.go). It's the CLI face of the app's scripts panel,
// and the engine behind it: the app spawns `sm run --project-id P
// --worktree-id W -- <script>` in its console, and the CLI picks the
// package manager, injects the SHIGOMORI_* env contract, bumps the
// shared use log, then replaces itself with the manager via exec: the
// script owns the terminal, signals, and exit code exactly as if the
// user had typed `pnpm run <script>` (or `just <recipe>`) there. The
// list form's --json is the panel's read: scripts, manager, per-script
// use stats, and the project's saved sort and manual order.

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

// One script. A slice, not a map: the list form prints scripts in
// manifest order, like `pnpm run` with no arguments. runner and target
// are set for a justfile recipe or Makefile target: the tool that runs
// it and the name it goes by there.
type packageScript struct {
	Name    string `json:"name"`
	Command string `json:"command"`
	runner  string
	target  string
}

func cmdRun(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		// App plumbing: exact addressing by the ids the app holds.
		strings: map[string][]string{"project-id": {}, "worktree-id": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	positionals := parsed.positionals

	target, err := runTarget(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}

	scripts, files, err := readWorktreeScripts(target.worktree.Path)
	if err != nil {
		return 1, err
	}
	manager := detectPackageManager(target.worktree.Path)

	if len(positionals) == 0 {
		return listPackageScripts(target.proj, manager, files, scripts)
	}
	if jsonMode {
		return 2, usageErrf(
			"`%s run <script>` hands the terminal to the script. --json only applies to the list form.",
			binaryName)
	}

	script, extra, found := findScript(scripts, positionals)
	if !found {
		if len(scripts) == 0 {
			return 1, errf("%s in %s has no scripts.", strings.Join(files, ", "), target.worktree.Path)
		}
		names := joinMapped(scripts, func(s packageScript) string { return s.Name })
		return 1, errf("No script named %q. Scripts: %s.", positionals[0], names)
	}

	in := runEnvInputs(target, script.Name)

	tool, argv := manager, runArgv(manager, script.Name, extra)
	if script.runner != "" {
		tool, argv = script.runner, append([]string{script.runner, script.target}, extra...)
	}
	toolPath, lookErr := exec.LookPath(tool)
	if lookErr != nil {
		if script.runner != "" {
			return 1, errf("%s isn't on PATH.", tool)
		}
		return 1, errf("%s isn't on PATH (the %s lockfile selects it).", tool, target.worktree.Name)
	}
	// The worktree root, not the cwd: a nested package.json (monorepo
	// subpackage) must not retarget the run. The scripts listed and
	// validated above are the root's.
	if err := os.Chdir(target.worktree.Path); err != nil {
		return 1, errf("cannot enter %s: %v", target.worktree.Path, err)
	}
	bumpPackageScriptUse(target.proj.ID, script.Name)
	execErr := syscall.Exec(toolPath, argv, scriptEnv(in))
	return 1, errf("failed to exec %s: %v", toolPath, execErr)
}

// The script the positionals name and the args left for it. A script
// is named whole ("just build" is one argument from the app), or, typed
// in a terminal, as `sm run just build`: the runner and the recipe as
// two words, unless package.json has a script called "just" itself.
func findScript(scripts []packageScript, positionals []string) (packageScript, []string, bool) {
	byName := func(name string) (packageScript, bool) {
		at := slices.IndexFunc(scripts, func(s packageScript) bool { return s.Name == name })
		if at < 0 {
			return packageScript{}, false
		}
		return scripts[at], true
	}
	if script, ok := byName(positionals[0]); ok {
		return script, positionals[1:], true
	}
	if len(positionals) > 1 {
		if script, ok := byName(positionals[0] + " " + positionals[1]); ok && script.runner != "" {
			return script, positionals[2:], true
		}
	}
	return packageScript{}, nil, false
}

// The env-contract values for the run, from lifecycleEnvInputs, the
// same resolver the lifecycle scripts use, so the two paths can't
// drift.
func runEnvInputs(target located, scriptName string) scriptEnvInputs {
	in := lifecycleEnvInputs(target.proj, target.worktree, readProjectConfig(target.proj.ID))
	in.scriptName = scriptName
	return in
}

// Unlike the worktree commands, run takes no names, paths, or -p: it
// acts where you stand, in any registered project's checkout or
// worktree. Running a script somewhere you aren't is the app's
// scripts panel's job. --worktree-id stays for app plumbing.
func runTarget(ctx cliContext, parsed parsedArgs) (located, error) {
	if wid := parsed.strings["worktree-id"]; wid != "" {
		return resolveWorktreeByID(ctx, parsed.strings["project-id"], wid)
	}
	if ctx.current != nil {
		return *ctx.current, nil
	}
	if ctx.unregisteredRepo != "" {
		return located{}, usageErrf(
			"This repo (%s) isn't registered as a project. Register it with `%s projects add` to run scripts here.",
			ctx.unregisteredRepo, binaryName)
	}
	return located{}, usageErrf(
		"`%s run` only works inside a registered project's checkout or worktree. %s",
		binaryName, projectHint(ctx))
}

// --json: {ok, packageManager, files, scripts: [{name, command}] in
// manifest order, usage: {<name>: {lastUsed, recentCount}}, sort,
// order}. packageManager is null without a package.json, and files
// names the script files found (package.json, justfile, Makefile). The
// app's PackageScriptsResultSchema is this with scripts folded into a
// name -> command record (an array here, because a record can't hold
// manifest order across every JSON reader). sort is the project's
// saved PackageScriptSortMode ("frequent" when unset) and order the
// "manual" sort's stored script order ([] when unset).
func listPackageScripts(proj project, manager string, files []string, scripts []packageScript) (int, error) {
	if jsonMode {
		if scripts == nil {
			scripts = []packageScript{}
		}
		useLog := readStateHintKey[map[string]map[string][]int64]("packageScriptUseLog")[proj.ID]
		now := time.Now()
		usage := make(map[string]useStat, len(scripts))
		for _, script := range scripts {
			usage[script.Name] = useStatOf(useLog[script.Name], now)
		}
		sortMode := readStateHintKey[map[string]string]("packageScriptSort")[proj.ID]
		order := readStateHintKey[map[string][]string]("packageScriptOrder")[proj.ID]
		if order == nil {
			order = []string{}
		}
		var managerField any
		if manager != "" {
			managerField = manager
		}
		emit(map[string]any{
			"ok": true, "packageManager": managerField, "files": files, "scripts": scripts,
			"usage": usage, "sort": cmp.Or(sortMode, "frequent"), "order": order,
		})
		return 0, nil
	}
	if len(scripts) == 0 {
		note(dimErr("no scripts in " + strings.Join(files, ", ")))
		return 0, nil
	}
	rows := make([][]string, len(scripts))
	for i, s := range scripts {
		rows[i] = []string{cyanOut(s.Name), dimOut(s.Command)}
	}
	for _, line := range alignRows(rows) {
		out(line)
	}
	if manager != "" {
		note(dimErr(fmt.Sprintf("package.json scripts run with %s: `%s run <script>`", manager, binaryName)))
	} else {
		note(dimErr(fmt.Sprintf("`%s run <script>`", binaryName)))
	}
	return 0, nil
}

// Every script the worktree root offers, package.json's first, then the
// justfile's recipes and the Makefile's targets, and the files they
// came from. No script file at all is the coded no-scripts failure,
// which the app's panel reads as "no scripts section", not as a
// failure.
func readWorktreeScripts(dir string) ([]packageScript, []string, error) {
	var scripts []packageScript
	files := []string{}
	pkg, err := readWorktreePackageScripts(dir)
	switch {
	case err == nil:
		scripts = pkg
		files = append(files, "package.json")
	case errorKindOf(err) != "no-package-json":
		return nil, nil, err
	}
	for _, source := range []struct {
		file  string
		parse func(string) []packageScript
	}{
		{findJustfile(dir), parseJustfile},
		{findMakefile(dir), parseMakefile},
	} {
		if source.file == "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, source.file))
		if err != nil {
			return nil, nil, errf("%s: %v", source.file, err)
		}
		scripts = append(scripts, source.parse(string(raw))...)
		files = append(files, source.file)
	}
	if len(files) == 0 {
		return nil, nil, codedErrf("no-scripts", "No package.json, justfile or Makefile in %s.", dir)
	}
	return scripts, files, nil
}

// package.json's scripts in manifest order: only string-valued
// entries count, and a missing or non-object scripts block means "no
// scripts". A missing or unparseable file is an error with the path in
// it (coded no-package-json for the missing case).
func readWorktreePackageScripts(dir string) ([]packageScript, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, codedErrf("no-package-json", "No package.json in %s.", dir)
		}
		return nil, errf("package.json: %v", err)
	}
	scripts, parseErr := parsePackageScripts(raw)
	if parseErr != nil {
		return nil, errf("%s: %v", filepath.Join(dir, "package.json"), parseErr)
	}
	return scripts, nil
}

func parsePackageScripts(raw []byte) ([]packageScript, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, err
	}
	scriptsRaw, ok := top["scripts"]
	if !ok {
		return nil, nil
	}
	// Token-walk the scripts object instead of unmarshaling into a map,
	// which would lose the manifest order.
	dec := json.NewDecoder(bytes.NewReader(scriptsRaw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, nil
	}
	var scripts []packageScript
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		var command string
		if json.Unmarshal(value, &command) == nil {
			scripts = append(scripts, packageScript{Name: key, Command: command})
		}
	}
	return scripts, nil
}

// npm only forwards extra args to the script after `--`. pnpm, yarn,
// and bun forward bare positionals themselves.
func runArgv(manager, script string, extra []string) []string {
	argv := []string{manager, "run", script}
	if len(extra) > 0 && manager == "npm" {
		argv = append(argv, "--")
	}
	return append(argv, extra...)
}

// One run in state.json's packageScriptUseLog, the rolling log the
// scripts panel's "most used" sort ranks by (read back by `sm run
// --json`'s usage). Every run counts here, the app's included: its
// scripts panel runs through `sm run`.
func bumpPackageScriptUse(projectID, script string) {
	err := updateStateKey("packageScriptUseLog", func(raw json.RawMessage) (any, error) {
		log := map[string]map[string][]int64{}
		if err := decodeKey(statePath(), "packageScriptUseLog", raw, &log); err != nil {
			return nil, err
		}
		projectLog := log[projectID]
		if projectLog == nil {
			projectLog = map[string][]int64{}
		}
		projectLog[script] = pruneAndAppendUse(projectLog[script])
		log[projectID] = projectLog
		return log, nil
	})
	if err != nil {
		vlog("[run] use log bump failed: %v", err)
		noteStateTrouble(err)
	}
}
