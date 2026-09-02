package main

// sm create: new managed worktree, then the create lifecycle awaited
// to completion (the app fires it in the background via --json; a CLI
// caller wants the worktree ready when the command returns).
// Sequencing: carry-over -> setup -> port-pool provision. Human mode streams
// progress to stderr, prints the path as the only stdout line, then
// drops into a subshell in the new worktree (--no-cd skips it);
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
			"project":    {"p"},
			"branch":     {"b"},
			"base":       {},
			"project-id": {}, // app plumbing: exact addressing from IPC
		},
		// checkout: reuse the existing branch `base` instead of creating
		// one -- the app's "open existing branch" flow. Requires --base.
		// no-cd: don't open a subshell in the new worktree afterwards.
		bools: map[string][]string{"checkout": {}, "no-cd": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	name := parsed.positional(0)
	if isPrimaryKeyword(name) {
		return 2, usageErrf("%q is reserved -- it addresses the project's primary checkout.", name)
	}
	if name != "" && !isValidWorktreeDirName(name) {
		return 2, usageErrf("%q is not a valid worktree folder name.", name)
	}
	for _, refFlag := range []string{"branch", "base"} {
		if v := parsed.strings[refFlag]; v != "" && strings.HasPrefix(v, "-") {
			return 2, usageErrf("Invalid --%s: %q is not a valid git ref name.", refFlag, v)
		}
	}

	worktree, err := createWorktree(proj, name, parsed.strings["branch"], parsed.strings["base"], parsed.bools["checkout"])
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{"event": "created", "worktree": worktree})
	} else {
		note("created " + cyanErr(worktree.Name) + " (branch " + cyanErr(worktree.Branch) + ")")
	}
	code := finishCreateLifecycle(proj, worktree, parsed.strings["base"])
	// Callers who can be moved land in the new worktree (a subshell,
	// or their own shell via the integration directive, same as
	// `sm cd`). --no-cd, --json, and scripts skip it. Exit 3 from a
	// failed lifecycle step outranks the shell's own exit code.
	if parsed.bools["no-cd"] || jsonMode ||
		(!interactiveStdio() && cdDirectiveFile() == "") {
		return code, nil
	}
	shellCode, err := enterWorktreeShell(worktree.Name, worktree.Path)
	if code != 0 {
		return code, err
	}
	return shellCode, err
}

// Shared tail of create and adopt: run the lifecycle, report script
// failures, print the path as the stdout result. 0 when everything
// ran; 3 when the worktree exists but a lifecycle step failed.
func finishCreateLifecycle(proj project, worktree worktreeJSON, base string) int {
	failures := runCreateLifecycle(proj, worktree, base)
	ok := len(failures) == 0
	if jsonMode {
		emit(map[string]any{
			"event": "done", "ok": ok, "path": worktree.Path,
			"worktree": worktree, "failures": failures,
		})
	} else {
		for _, f := range failures {
			if f.ExitCode == nil {
				note(yellowErr("warning:") + fmt.Sprintf(" %s failed to run", f.Step))
			} else {
				note(yellowErr("warning:") + fmt.Sprintf(" %s exited with code %v", f.Step, f.ExitCode))
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
		note(dimErr("["+labels[phase]+"]") + " …")
	}
}

// Carry-over -> setup -> port-pool, collecting non-zero script exits.
// `base` is the ref the worktree was branched from ("" when unknown).
// It decides which checkout carry-over looks in first.
func runCreateLifecycle(proj project, worktree worktreeJSON, base string) []scriptFailure {
	failures := []scriptFailure{}
	config := readProjectConfig(proj.ID)

	// Manual entries and every checkout's .worktreeinclude are looked
	// up across the same ordered sources. Include resolution is
	// best-effort: a broken file must not abort creation. Its error
	// rides the report instead.
	manual := []carryOverEntry{}
	if config != nil {
		manual = config.CarryOver
	}
	var sources []worktreeIdentity
	var include []carryOverEntry
	var includeFailures []carryOverFailure
	if len(manual) > 0 || worktreeIncludeEnabled(config) {
		sources = carryOverSources(proj, worktree.Path, base)
		include, includeFailures = resolveWorktreeIncludeAcross(sources, config)
	}

	entries := mergeCarryOver(manual, include)
	if len(entries) > 0 || len(includeFailures) > 0 {
		emitPhase("carryOver")
		report := applyCarryOver(sources, worktree.Path, entries)
		if len(includeFailures) > 0 {
			report.IncludeFailures = includeFailures
		}
		if jsonMode {
			emit(map[string]any{"event": "carryOver", "report": report})
		} else {
			line := dimErr("[carry-over]") + fmt.Sprintf(" %d applied", report.Applied)
			if len(report.Failures) > 0 {
				line += fmt.Sprintf(", %d failed", len(report.Failures))
			}
			note(line)
			for _, s := range report.Sourced {
				how := ""
				if s.CopiedInstead {
					how = " (copied: symlinks only target the primary)"
				}
				note(dimErr("[carry-over]") + fmt.Sprintf(" %s from %s%s", s.Path, s.Source, how))
			}
			for _, f := range append(report.Failures, report.IncludeFailures...) {
				where := ""
				if f.Source != "" {
					where = " in " + f.Source
				}
				note(dimErr("[carry-over]") + fmt.Sprintf(" %s%s: %s", f.Path, where, f.Reason))
			}
		}
	}

	provisionFailures, _ := runProvisionScripts(proj, identityOf(worktree), config)
	failures = append(failures, provisionFailures...)
	emitPhase("idle")
	return failures
}

// The provisioning half shared by create/adopt and `sm setup`: the
// project's setup script, then port-pool provision (skipped for
// external worktrees -- rm skips the matching release for them, so
// provisioning would leak a port). Returns the failures and which
// steps ran; callers own the trailing "idle" phase.
func runProvisionScripts(proj project, id worktreeIdentity, config *projectConfig) ([]scriptFailure, []string) {
	failures := []scriptFailure{}
	ran := []string{}
	setupCommand := ""
	if config != nil {
		setupCommand = strings.TrimSpace(config.Scripts.Setup)
	}
	portPoolNeeded := willRunPortPool(id)
	if setupCommand == "" && !portPoolNeeded {
		return failures, ran
	}

	envInputs := lifecycleEnvInputs(proj, id, config)

	if setupCommand != "" {
		emitPhase("setup")
		envInputs.scriptName = "setup"
		ran = append(ran, "setup")
		if code, _ := runLifecycleScript(setupCommand, envInputs, scriptSlot{Kind: "setup"}); code != 0 {
			failures = append(failures, scriptFailure{Step: "setup", ExitCode: codeOrNil(code)})
		}
	}

	if portPoolNeeded {
		emitPhase("portPoolProvision")
		envInputs.scriptName = "port-pool-provision"
		ran = append(ran, "port-pool provision")
		code, _ := runLifecycleScript(
			portPoolCommand("provision", id.Path), envInputs,
			scriptSlot{Kind: "portPool", Phase: "provision"})
		if code != 0 {
			failures = append(failures, scriptFailure{Step: "port-pool provision", ExitCode: codeOrNil(code)})
		}
	}

	return failures, ran
}

func codeOrNil(code int) any {
	if code < 0 {
		return nil
	}
	return code
}

// $SHIGOMORI_PROJECT_BRANCH + $SHIGOMORI_DEFAULT_BRANCH for scripts.
func lifecycleEnvInputs(proj project, id worktreeIdentity, config *projectConfig) scriptEnvInputs {
	projectBranch := ""
	if primary, err := primaryOf(proj); err == nil {
		projectBranch = primary.worktree.Branch
	}
	return scriptEnvInputs{
		worktree:      id,
		proj:          proj,
		projectBranch: projectBranch,
		defaultBranch: primaryRefFor(proj, config),
	}
}
