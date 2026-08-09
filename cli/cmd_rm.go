package main

// sm rm: remove a worktree through the same cleanup pipeline as the
// app (deleteWorktreeWithCleanup in main/lib/worktrees/operations.ts):
// port-pool release -> teardown -> `git worktree remove` -> branch
// delete per settings -> state cleanup. Cleanup runs even on --force
// (force only bypasses the uncommitted-changes guard); externals skip
// cleanup entirely since the app never provisioned them. With no name
// it removes the worktree containing cwd and prints a cd hint.

import (
	"fmt"
	"strings"
)

func cmdRm(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.bools["force"] = []string{"f"}
	spec.bools["keep-branch"] = nil
	// App plumbing: retry a delete whose cleanup script failed without
	// re-running the failing cleanup, mirroring the app's skip-cleanup
	// affordance.
	spec.bools["skip-cleanup"] = nil
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree
	force := parsed.bools["force"]

	if id.IsPrimary {
		return 1, errf("Cannot delete the project's primary worktree")
	}
	if !force {
		// Fail closed: an unreadable status must not pass for clean when
		// the next step destroys the directory.
		changed, err := changedCount(id.Path)
		if err != nil {
			return 1, errf("Couldn't check for uncommitted changes (%v). Fix the worktree, or pass --force to remove anyway.", err)
		}
		if changed > 0 {
			return 1, errf("Worktree has %d uncommitted change(s). Pass --force to remove anyway.", changed)
		}
	}

	global := readGlobalConfig()
	config := readProjectConfig(proj.ID)

	// Cleanup scripts (skip for externals -- no provision ever ran).
	if !id.IsExternal && !parsed.bools["skip-cleanup"] {
		envInputs := lifecycleEnvInputs(proj, id, config)

		portPoolEnabled := global.PortPool != nil && *global.PortPool
		if portPoolEnabled && portPoolInstalled() && portPoolConfigured(id.Path) {
			envInputs.scriptName = "port-pool-release"
			code, runID := runLifecycleScript(
				portPoolCommand("release", id.Path), envInputs,
				scriptSlot{Kind: "portPool", Phase: "release"})
			if code != 0 {
				return cleanupFailed("portPoolRelease", code, runID)
			}
		}
		teardown := ""
		if config != nil {
			teardown = strings.TrimSpace(config.Scripts.Teardown)
		}
		if teardown != "" {
			envInputs.scriptName = "teardown"
			if code, runID := runLifecycleScript(teardown, envInputs, scriptSlot{Kind: "teardown"}); code != 0 {
				return cleanupFailed("teardown", code, runID)
			}
		}
	}

	if force {
		if err := removeWorktreeForce(proj.Path, id.Path); err != nil {
			return 1, err
		}
	} else if err := gitWorktreeRemove(proj.Path, id.Path, false); err != nil {
		return 1, err
	}
	invalidateWorktreeIdentities(proj.ID)
	if !id.IsExternal {
		pruneEmptyManagedParents(id.Path, proj.Path)
	}

	if err := dropShelved(id.ID); err != nil {
		vlog("[state] drop shelved: %v", err)
	}
	deleteBranch := !parsed.bools["keep-branch"] &&
		(global.DeleteBranchOnRemove == nil || *global.DeleteBranchOnRemove)
	deleteBranchAfterWorktreeRemoval(proj.Path, id, deleteBranch)
	deleteWorktreeData(proj.ID, id.ID)

	hint := ""
	if cwdInside(id.Path) {
		hint = proj.Path
	}
	if jsonMode {
		result := map[string]any{
			"ok": true,
			"removed": map[string]any{
				"id": id.ID, "name": id.Name, "branch": id.Branch,
				"path": id.Path, "projectName": proj.Name,
			},
		}
		if hint != "" {
			result["cdHint"] = hint
		}
		emit(result)
	} else {
		out(greenOut("removed " + id.Name))
		if hint != "" {
			note(dimErr("note: your shell is inside the removed worktree -- cd " + hint))
		}
	}
	return 0, nil
}

// runID rides along so JSON consumers (the app's DeleteWorktreeResult
// schema requires it) can correlate the failing script's output.
func cleanupFailed(phase string, code int, runID string) (int, error) {
	if jsonMode {
		emit(map[string]any{
			"ok": false,
			"cleanupError": map[string]any{
				"phase": phase, "exitCode": codeOrNil(code), "runId": runID,
			},
		})
		return 1, nil
	}
	detail := "failed to run"
	if code >= 0 {
		detail = fmt.Sprintf("exited with code %d", code)
	}
	return 1, errf("%s %s; worktree not removed", phase, detail)
}
