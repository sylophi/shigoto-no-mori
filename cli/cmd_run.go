package main

// sm run: run (or list) the package.json scripts of the worktree
// containing the cwd. It's the CLI face of the app's scripts panel,
// and the engine behind it: the app spawns `sm run --project-id P
// --worktree-id W -- <script>` in its console, and the CLI picks the
// package manager, injects the SHIGOMORI_* env contract, bumps the
// shared use log, then replaces itself with the manager via exec: the
// script owns the terminal, signals, and exit code exactly as if the
// user had typed `pnpm run <script>` there. The list form's --json is
// the panel's read: scripts, manager, per-script use stats, and the
// project's saved sort and manual order.

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"time"
)

// One package.json scripts entry. A slice, not a map: the list form
// prints scripts in manifest order, like `pnpm run` with no arguments.
type packageScript struct {
	Name    string `json:"name"`
	Command string `json:"command"`
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

	scripts, err := readWorktreePackageScripts(target.worktree.Path)
	if err != nil {
		return 1, err
	}
	manager := detectPackageManager(target.worktree.Path)

	if len(positionals) == 0 {
		return listPackageScripts(target.proj, manager, scripts)
	}
	if jsonMode {
		return 2, usageErrf(
			"`%s run <script>` hands the terminal to the script. --json only applies to the list form.",
			binaryName)
	}

	name := positionals[0]
	if !slices.ContainsFunc(scripts, func(s packageScript) bool { return s.Name == name }) {
		if len(scripts) == 0 {
			return 1, errf("package.json in %s has no scripts.", target.worktree.Path)
		}
		names := joinMapped(scripts, func(s packageScript) string { return s.Name })
		return 1, errf("No script named %q. Scripts: %s.", name, names)
	}

	in := runEnvInputs(target, name)

	managerPath, lookErr := exec.LookPath(manager)
	if lookErr != nil {
		return 1, errf("%s isn't on PATH (the %s lockfile selects it).", manager, target.worktree.Name)
	}
	// The worktree root, not the cwd: a nested package.json (monorepo
	// subpackage) must not retarget the run. The scripts listed and
	// validated above are the root's.
	if err := os.Chdir(target.worktree.Path); err != nil {
		return 1, errf("cannot enter %s: %v", target.worktree.Path, err)
	}
	bumpPackageScriptUse(target.proj.ID, name)
	execErr := syscall.Exec(managerPath, runArgv(manager, name, positionals[1:]), scriptEnv(in))
	return 1, errf("failed to exec %s: %v", managerPath, execErr)
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

// --json: {ok, packageManager, scripts: [{name, command}] in manifest
// order, usage: {<name>: {lastUsed, recentCount}}, sort, order}. The
// app's PackageScriptsResultSchema is this with scripts folded into a
// name -> command record (an array here, because a record can't hold
// manifest order across every JSON reader). sort is the project's
// saved PackageScriptSortMode ("frequent" when unset) and order the
// "manual" sort's stored script order ([] when unset).
func listPackageScripts(proj project, manager string, scripts []packageScript) (int, error) {
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
		emit(map[string]any{
			"ok": true, "packageManager": manager, "scripts": scripts, "usage": usage,
			"sort": cmp.Or(sortMode, "frequent"), "order": order,
		})
		return 0, nil
	}
	if len(scripts) == 0 {
		note(dimErr("no scripts in package.json"))
		return 0, nil
	}
	rows := make([][]string, len(scripts))
	for i, s := range scripts {
		rows[i] = []string{cyanOut(s.Name), dimOut(s.Command)}
	}
	for _, line := range alignRows(rows) {
		out(line)
	}
	note(dimErr(fmt.Sprintf("runs with %s: `%s run <script>`", manager, binaryName)))
	return 0, nil
}

// package.json's scripts in manifest order: only string-valued
// entries count, and a missing or non-object scripts block means "no
// scripts". A missing or unparseable file is an error with the path in
// it (coded no-package-json for the missing case, which the app's
// panel shows as "no scripts").
func readWorktreePackageScripts(dir string) ([]packageScript, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		if os.IsNotExist(err) {
			// Coded: the app's panel reads "no package.json" as "no
			// scripts section", not as a failure.
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
