package main

// sm agent-working and create --agent-working: the mark lands on the
// row and the identity, the primary refuses it, and rm drops it.
// Against real git in a temp SHIGOMORI_DATA_DIR.

import (
	"path/filepath"
	"testing"
)

func agentWorkingMarks(t *testing.T) map[string]bool {
	t.Helper()
	return readRegistryMarkSet(agentWorkingKey)
}

func TestAgentWorkingMark(t *testing.T) {
	proj := autoPullSandbox(t)
	ctx := resolveContext(proj.Path, []project{proj})

	if code, err := cmdCreate(ctx, []string{"--no-cd", "--no-setup", "--agent-working", "fox"}); code != 0 || err != nil {
		t.Fatalf("create --agent-working: %d, %v", code, err)
	}
	config := readProjectConfig(proj.ID)
	fox := identityAt(t, proj, filepath.Join(resolveWorktreeBase(proj.Path, config), "fox"))
	if !agentWorkingMarks(t)[fox.ID] {
		t.Fatalf("create --agent-working left the worktree unmarked")
	}
	if row := buildWorktree(proj, fox, loadBuildContext(proj)); !row.AgentWorking {
		t.Fatalf("row of an agent-working worktree says agentWorking: false")
	}

	if code, err := cmdRegistryMark(ctx, []string{"off", "fox"}, agentWorkingMark); code != 0 || err != nil {
		t.Fatalf("agent-working off: %d, %v", code, err)
	}
	if agentWorkingMarks(t)[fox.ID] {
		t.Fatalf("agent-working off left the mark")
	}
	if code, err := cmdRegistryMark(ctx, []string{"on", "fox"}, agentWorkingMark); code != 0 || err != nil {
		t.Fatalf("agent-working on: %d, %v", code, err)
	}
	if !agentWorkingMarks(t)[fox.ID] {
		t.Fatalf("agent-working on didn't mark it")
	}

	if code, _ := cmdRegistryMark(ctx, []string{"on", "primary"}, agentWorkingMark); code == 0 {
		t.Fatalf("agent-working on the primary succeeded")
	}

	if _, err := execRemove(proj, fox, removeOptions{force: true, skipCleanup: true}); err != nil {
		t.Fatal(err)
	}
	if agentWorkingMarks(t)[fox.ID] {
		t.Fatalf("rm left the agent-working mark behind")
	}
}
