package main

// sm run: run (or list) the package.json scripts of the worktree
// containing the cwd -- the CLI face of the app's scripts panel, and
// the engine behind it (the app delegates its own runs through
// `sm run --worktree-id ...`, see main/ipc/modules/packageScripts.ts).
// The CLI picks the package manager, injects the SHIGOMORI_* env
// contract, bumps the shared use log, then replaces itself with the
// manager via exec: the script owns the terminal, signals, and exit
// code exactly as if the user had typed `pnpm run <script>` there.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

// One package.json scripts entry. A slice, not a map: the list form
// prints scripts in manifest order, like `pnpm run` with no arguments.
type packageScript struct {
	Name    string `json:"name"`
	Command string `json:"command"`
}

func cmdRun(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project-id":  {},
			"worktree-id": {},
			// Supplied by the app so a delegated run reuses the branch
			// resolution its IPC handler already performed instead of
			// re-spawning git here.
			"project-branch": {},
			"default-branch": {},
		},
		// App plumbing: the app records the use itself, in-process, so
		// its state watcher can suppress the write as a self-echo. A
		// bump from this child would look like an external state.json
		// change and trigger a full refetch on every panel run.
		bools: map[string][]string{"skip-use-log": {}},
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
		return listPackageScripts(manager, scripts)
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
		names := make([]string, len(scripts))
		for i, s := range scripts {
			names[i] = s.Name
		}
		return 1, errf("No script named %q. Scripts: %s.", name, strings.Join(names, ", "))
	}

	in := runEnvInputs(target, parsed, name)

	managerPath, lookErr := exec.LookPath(manager)
	if lookErr != nil {
		return 1, errf("%s isn't on PATH (the %s lockfile selects it).", manager, target.worktree.Name)
	}
	// The worktree root, not the cwd: a nested package.json (monorepo
	// subpackage) must not retarget the run -- the scripts listed and
	// validated above are the root's.
	if err := os.Chdir(target.worktree.Path); err != nil {
		return 1, errf("cannot enter %s: %v", target.worktree.Path, err)
	}
	if !parsed.bools["skip-use-log"] {
		bumpPackageScriptUse(target.proj.ID, name)
	}
	execErr := syscall.Exec(managerPath, runArgv(manager, name, positionals[1:]), scriptEnv(in))
	return 1, errf("failed to exec %s: %v", managerPath, execErr)
}

// The env-contract values for the run. The app-plumbing branch flags
// win when present: a delegated run's IPC handler resolved both
// branches moments earlier, so recomputing them here would only
// re-spawn git for answers the caller already has. Anything not
// supplied comes from lifecycleEnvInputs, the same resolver the
// lifecycle scripts use, so the two paths can't drift.
func runEnvInputs(target located, parsed parsedArgs, scriptName string) scriptEnvInputs {
	projectBranch, haveProject := parsed.strings["project-branch"]
	defaultBranch, haveDefault := parsed.strings["default-branch"]
	in := scriptEnvInputs{
		worktree:      target.worktree,
		proj:          target.proj,
		scriptName:    scriptName,
		projectBranch: projectBranch,
		defaultBranch: defaultBranch,
	}
	if haveProject && haveDefault {
		return in
	}
	computed := lifecycleEnvInputs(target.proj, target.worktree, readProjectConfig(target.proj.ID))
	if !haveProject {
		in.projectBranch = computed.projectBranch
	}
	if !haveDefault {
		in.defaultBranch = computed.defaultBranch
	}
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

func listPackageScripts(manager string, scripts []packageScript) (int, error) {
	if jsonMode {
		if scripts == nil {
			scripts = []packageScript{}
		}
		emit(map[string]any{"ok": true, "packageManager": manager, "scripts": scripts})
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
	note(dimErr(fmt.Sprintf("runs with %s -- `%s run <script>`", manager, binaryName)))
	return 0, nil
}

// Ordered port of readPackageScripts (main/lib/scripts/
// packageScripts.ts): only string-valued entries count, and a missing
// or non-object scripts block means "no scripts". The TS side returns
// null for a missing or unparseable file. Here those are real errors
// with the path in them, since someone asked for this directory.
func readWorktreePackageScripts(dir string) ([]packageScript, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errf("No package.json in %s.", dir)
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

// Port of bumpScriptUseCount (main/lib/scripts/packageScriptStats.ts):
// same state.json key, same rolling window, so the app's "most used"
// sort counts terminal runs too.
func bumpPackageScriptUse(projectID, script string) {
	err := updateStateKey("packageScriptUseLog", func(raw json.RawMessage) (any, error) {
		log := map[string]map[string][]int64{}
		if raw != nil {
			if err := json.Unmarshal(raw, &log); err != nil {
				return nil, malformedKeyErr(statePath(), "packageScriptUseLog", err)
			}
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
