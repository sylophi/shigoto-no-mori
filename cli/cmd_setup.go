package main

// sm setup: re-run the provisioning half of the create lifecycle on
// an existing worktree -- the recovery path for create/adopt exit 3
// (worktree exists, setup failed) and for setup scripts that changed
// after the worktree was made. Runs the project's setup script, then
// port-pool provision under the same gating as create. Carry-over is
// deliberately not repeated: its entries already exist and would only
// report EEXIST noise.
//
// Port-pool provision is skipped for external worktrees: rm skips the
// matching release for them, so provisioning would leak a port.

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
	target, err := resolveWorktree(ctx, ref, parsed.strings["project"], true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	config := readProjectConfig(proj.ID)
	failures, ran := runProvisionScripts(proj, id, config)
	if len(ran) == 0 {
		if jsonMode {
			emit(map[string]any{"ok": true, "ran": []string{}})
		} else {
			note(dimErr("nothing to run: no setup script configured" +
				" and port-pool isn't active for this worktree"))
		}
		return 0, nil
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
