package main

// sm rm: remove a worktree through the full cleanup pipeline:
// port-pool release -> teardown -> `git worktree remove` -> branch
// delete per settings -> state cleanup. Cleanup runs even on --force
// (force only bypasses the uncommitted-changes guard); externals skip
// cleanup entirely since the app never provisioned them. With no name
// it removes the worktree containing cwd and prints a cd hint.

import (
	"errors"
	"fmt"
	"strings"
)

type removeOptions struct {
	force, keepBranch, skipCleanup bool
	// The caller already ran removePreflight (land does, before the
	// merge), so execRemove must not spawn the status probe again.
	preflighted bool
}

// The removal flag set and its parse, shared by rm and land so the
// composed command can't drift from the one it composes.
func addRemoveFlags(spec argSpec) {
	spec.bools["force"] = []string{"f"}
	spec.bools["keep-branch"] = nil
	// App plumbing: retry a delete whose cleanup script failed without
	// re-running the failing cleanup, mirroring the app's skip-cleanup
	// affordance.
	spec.bools["skip-cleanup"] = nil
}

func removeOptionsFrom(parsed parsedArgs) removeOptions {
	return removeOptions{
		force:       parsed.bools["force"],
		keepBranch:  parsed.bools["keep-branch"],
		skipCleanup: parsed.bools["skip-cleanup"],
	}
}

// The guards every removal shares: never the primary checkout, and
// fail closed on a dirty or unreadable worktree unless forced -- an
// unreadable status must not pass for clean when the next step
// destroys the directory.
func removePreflight(id worktreeIdentity, force bool) error {
	if id.IsPrimary {
		return errf("Cannot delete the project's primary worktree")
	}
	if force {
		return nil
	}
	changed, err := changedCount(id.Path)
	if err != nil {
		return errf("Couldn't check for uncommitted changes (%v). Fix the worktree, or pass --force to remove anyway.", err)
	}
	if changed > 0 {
		return errf("Worktree has %d uncommitted change(s). Pass --force to remove anyway.", changed)
	}
	return nil
}

// A lifecycle script failed during removal, so the worktree was left
// in place. Typed so callers shape their own report: rm's --json
// document must carry phase/exitCode/runId (the app's
// DeleteWorktreeResult schema), and land wraps it after a merge that
// already happened.
type cleanupError struct {
	phase string
	code  int
	runID string
}

func (e *cleanupError) Error() string {
	detail := "failed to run"
	if e.code >= 0 {
		detail = fmt.Sprintf("exited with code %d", e.code)
	}
	return fmt.Sprintf("%s %s; worktree not removed", e.phase, detail)
}

func cleanupErrorDoc(e *cleanupError) map[string]any {
	return map[string]any{
		"phase": e.phase, "exitCode": codeOrNil(e.code), "runId": e.runID,
	}
}

// execRemove runs the whole removal pipeline for a resolved worktree
// and returns the primary path as a cd hint when the shell's cwd sat
// inside the removed directory ("" otherwise).
func execRemove(proj project, id worktreeIdentity, opts removeOptions) (string, error) {
	if !opts.preflighted {
		if err := removePreflight(id, opts.force); err != nil {
			return "", err
		}
	}

	global := readGlobalConfig()
	config := readProjectConfig(proj.ID)

	// Cleanup scripts (skip for externals -- no provision ever ran).
	if !id.IsExternal && !opts.skipCleanup {
		envInputs := lifecycleEnvInputs(proj, id, config)

		portPoolEnabled := global.PortPool != nil && *global.PortPool
		if portPoolEnabled && portPoolInstalled() && portPoolConfigured(id.Path) {
			envInputs.scriptName = "port-pool-release"
			code, runID := runLifecycleScript(
				portPoolCommand("release", id.Path), envInputs,
				scriptSlot{Kind: "portPool", Phase: "release"})
			if code != 0 {
				return "", &cleanupError{phase: "portPoolRelease", code: code, runID: runID}
			}
		}
		teardown := ""
		if config != nil {
			teardown = strings.TrimSpace(config.Scripts.Teardown)
		}
		if teardown != "" {
			envInputs.scriptName = "teardown"
			if code, runID := runLifecycleScript(teardown, envInputs, scriptSlot{Kind: "teardown"}); code != 0 {
				return "", &cleanupError{phase: "teardown", code: code, runID: runID}
			}
		}
	}

	if opts.force {
		if err := removeWorktreeForce(proj.Path, id.Path); err != nil {
			return "", err
		}
	} else if err := gitWorktreeRemove(proj.Path, id.Path, false); err != nil {
		return "", err
	}
	invalidateWorktreeIdentities(proj.ID)
	if !id.IsExternal {
		pruneEmptyManagedParents(id.Path, proj.Path)
	}

	if err := dropShelved(id.ID); err != nil {
		vlog("[state] drop shelved: %v", err)
	}
	deleteBranch := !opts.keepBranch &&
		(global.DeleteBranchOnRemove == nil || *global.DeleteBranchOnRemove)
	deleteBranchAfterWorktreeRemoval(proj.Path, id, deleteBranch)
	deleteWorktreeData(proj.ID, id.ID)

	if cwdInside(id.Path) {
		return proj.Path, nil
	}
	return "", nil
}

// Shared result report for rm and land: the removed document (an
// app-consumed shape) and the human line, plus the cd hint when the
// shell sat inside the removed directory. extra adds top-level keys
// to the JSON document (land's merge fields).
func reportRemoved(proj project, id worktreeIdentity, hint string, extra map[string]any) {
	if jsonMode {
		result := map[string]any{
			"ok": true,
			"removed": map[string]any{
				"id": id.ID, "name": id.Name, "branch": id.Branch,
				"path": id.Path, "projectName": proj.Name,
			},
		}
		for key, value := range extra {
			result[key] = value
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
}

func cmdRm(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	addRemoveFlags(spec)
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, false)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	hint, err := execRemove(proj, id, removeOptionsFrom(parsed))
	if err != nil {
		var ce *cleanupError
		if errors.As(err, &ce) && jsonMode {
			emit(map[string]any{"ok": false, "cleanupError": cleanupErrorDoc(ce)})
			return 1, nil
		}
		return exitCodeOf(err), err
	}

	reportRemoved(proj, id, hint, nil)
	return 0, nil
}
