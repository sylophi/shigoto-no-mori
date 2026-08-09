package main

// sgm setup: re-run the provisioning half of the create lifecycle on
// an existing worktree -- the recovery path for create/adopt exit 3
// (worktree exists, setup failed) and for setup scripts that changed
// after the worktree was made. Runs the project's setup script, then
// port-pool provision under the same gating as create. Carry-over is
// deliberately not repeated: its entries already exist and would only
// report EEXIST noise.
//
// Port-pool provision is skipped for external worktrees: rm skips the
// matching release for them, so provisioning would leak a port.

import "strings"

func cmdSetup(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	ref := ""
	if len(parsed.positionals) > 0 {
		ref = parsed.positionals[0]
	}
	target, err := resolveWorktree(ctx, ref, parsed.strings["project"])
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	config := readProjectConfig(proj.ID)
	setupCommand := ""
	if config != nil {
		setupCommand = strings.TrimSpace(config.Scripts.Setup)
	}
	portPoolNeeded := !id.IsExternal && willRunPortPool(id.Path)

	if setupCommand == "" && !portPoolNeeded {
		if jsonMode {
			emit(map[string]any{"ok": true, "ran": []string{}})
		} else {
			note(dimErr("nothing to run: no setup script configured" +
				" and port-pool isn't active for this worktree"))
		}
		return 0, nil
	}

	envInputs := lifecycleEnvInputs(proj, worktreeJSON{
		ID: id.ID, ProjectID: id.ProjectID, Name: id.Name,
		Branch: id.Branch, Path: id.Path,
		IsPrimary: id.IsPrimary, IsExternal: id.IsExternal, Detached: id.Detached,
	}, config)

	failures := []scriptFailure{}
	ran := []string{}
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
	emitPhase("idle")

	ok := len(failures) == 0
	if jsonMode {
		// The failures payload IS the error report; returning an error
		// here too would make main.go emit a second, conflicting
		// document (same policy as cmd_rm's cleanupFailed).
		emit(map[string]any{"ok": ok, "ran": ran, "failures": failures})
		if ok {
			return 0, nil
		}
		return 1, nil
	}
	if ok {
		out(greenOut("setup complete for " + id.Name))
		return 0, nil
	}
	return 1, errf("setup did not complete cleanly for %s", id.Name)
}
