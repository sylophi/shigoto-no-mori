package main

// sgm create: new managed worktree, then the create lifecycle awaited
// to completion (the app fires it in the background; a CLI caller
// wants the worktree ready when the command returns). Sequencing
// mirrors runCreateLifecycle in main/lib/worktrees/lifecycle.ts:
// carry-over -> setup -> port-pool provision. Human mode streams
// progress to stderr and prints the path as the only stdout line;
// --json streams NDJSON events ending with a "done" record. Exit 3
// when the worktree was created but a lifecycle step failed.

import (
	"fmt"
	"strings"
)

type scriptFailure struct {
	Step     string `json:"step"`
	ExitCode any    `json:"exitCode"` // int or nil (never ran / signaled)
}

func cmdCreate(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project": {"p"},
			"branch":  {"b"},
			"base":    {},
		},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, err := resolveProject(ctx, parsed.strings["project"])
	if err != nil {
		return exitCodeOf(err), err
	}
	name := ""
	if len(parsed.positionals) > 0 {
		name = parsed.positionals[0]
	}
	if name != "" && !isValidWorktreeDirName(name) {
		return 2, usageErrf("%q is not a valid worktree folder name.", name)
	}
	for _, refFlag := range []string{"branch", "base"} {
		if v := parsed.strings[refFlag]; v != "" && strings.HasPrefix(v, "-") {
			return 2, usageErrf("Invalid --%s: %q is not a valid git ref name.", refFlag, v)
		}
	}

	worktree, err := createWorktree(proj, name, parsed.strings["branch"], parsed.strings["base"], false)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{"event": "created", "worktree": worktree})
	} else {
		note(fmt.Sprintf("created %s (branch %s)", worktree.Name, worktree.Branch))
	}
	return finishCreateLifecycle(proj, worktree), nil
}

// Shared tail of create and adopt: run the lifecycle, report script
// failures, print the path as the stdout result. 0 when everything
// ran; 3 when the worktree exists but a lifecycle step failed.
func finishCreateLifecycle(proj project, worktree worktreeJSON) int {
	failures := runCreateLifecycle(proj, worktree)
	ok := len(failures) == 0
	if jsonMode {
		emit(map[string]any{
			"event": "done", "ok": ok, "path": worktree.Path,
			"worktree": worktree, "failures": failures,
		})
	} else {
		for _, f := range failures {
			if f.ExitCode == nil {
				note(fmt.Sprintf("warning: %s failed to run", f.Step))
			} else {
				note(fmt.Sprintf("warning: %s exited with code %v", f.Step, f.ExitCode))
			}
		}
		out(worktree.Path)
	}
	if ok {
		return 0
	}
	return 3
}

func emitPhase(phase string) {
	if jsonMode {
		emit(map[string]any{"event": "phase", "phase": phase})
	} else if phase != "idle" {
		labels := map[string]string{
			"carryOver":         "carry-over",
			"setup":             "setup",
			"portPoolProvision": "port-pool provision",
		}
		note("[" + labels[phase] + "] …")
	}
}

// Carry-over -> setup -> port-pool, collecting non-zero script exits.
func runCreateLifecycle(proj project, worktree worktreeJSON) []scriptFailure {
	failures := []scriptFailure{}
	config := readProjectConfig(proj.ID)

	// .worktreeinclude resolution is best-effort: a broken file must
	// not abort creation; its error rides the report instead.
	manual := []carryOverEntry{}
	if config != nil {
		manual = config.CarryOver
	}
	var includeFailures []carryOverFailure
	include, err := resolveWorktreeInclude(proj.Path, config)
	if err != nil {
		includeFailures = append(includeFailures,
			carryOverFailure{Path: worktreeIncludeFile, Reason: err.Error()})
	}

	entries := mergeCarryOver(manual, include)
	if len(entries) > 0 || len(includeFailures) > 0 {
		emitPhase("carryOver")
		report := applyCarryOver(proj.Path, worktree.Path, entries)
		if len(includeFailures) > 0 {
			report.IncludeFailures = includeFailures
		}
		if jsonMode {
			emit(map[string]any{"event": "carryOver", "report": report})
		} else {
			line := fmt.Sprintf("[carry-over] %d applied", report.Applied)
			if len(report.Failures) > 0 {
				line += fmt.Sprintf(", %d failed", len(report.Failures))
			}
			note(line)
			for _, f := range append(report.Failures, report.IncludeFailures...) {
				note(fmt.Sprintf("[carry-over] %s: %s", f.Path, f.Reason))
			}
		}
	}

	setupCommand := ""
	if config != nil {
		setupCommand = strings.TrimSpace(config.Scripts.Setup)
	}
	portPoolNeeded := willRunPortPool(worktree.Path)
	if setupCommand == "" && !portPoolNeeded {
		emitPhase("idle")
		return failures
	}

	envInputs := lifecycleEnvInputs(proj, worktree, config)

	if setupCommand != "" {
		emitPhase("setup")
		envInputs.scriptName = "setup"
		if code := runLifecycleScript(setupCommand, envInputs, scriptSlot{Kind: "setup"}); code != 0 {
			failures = append(failures, scriptFailure{Step: "setup", ExitCode: codeOrNil(code)})
		}
	}

	if portPoolNeeded {
		emitPhase("portPoolProvision")
		envInputs.scriptName = "port-pool-provision"
		code := runLifecycleScript(
			portPoolCommand("provision", worktree.Path), envInputs,
			scriptSlot{Kind: "portPool", Phase: "provision"})
		if code != 0 {
			failures = append(failures, scriptFailure{Step: "port-pool provision", ExitCode: codeOrNil(code)})
		}
	}

	emitPhase("idle")
	return failures
}

func codeOrNil(code int) any {
	if code < 0 {
		return nil
	}
	return code
}

// $SHIGOMORI_PROJECT_BRANCH + $SHIGOMORI_DEFAULT_BRANCH for scripts.
func lifecycleEnvInputs(proj project, worktree worktreeJSON, config *projectConfig) scriptEnvInputs {
	projectBranch := ""
	if identities, err := listWorktreeIdentities(proj); err == nil {
		for _, id := range identities {
			if id.IsPrimary {
				projectBranch = id.Branch
				break
			}
		}
	}
	override := ""
	if config != nil {
		override = config.DefaultBranch
	}
	return scriptEnvInputs{
		worktree: worktreeIdentity{
			ID: worktree.ID, ProjectID: worktree.ProjectID, Name: worktree.Name,
			Branch: worktree.Branch, Path: worktree.Path,
			IsPrimary: worktree.IsPrimary, IsExternal: worktree.IsExternal,
			Detached: worktree.Detached,
		},
		proj:          proj,
		projectBranch: projectBranch,
		defaultBranch: resolveDefaultBranch(proj.Path, override),
	}
}
