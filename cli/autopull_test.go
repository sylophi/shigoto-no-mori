package main

// The autoPullNew / autoPullPrimaryOnly settings (cmd_config.go) and
// the auto-pull mark they write to registry.json (state.go
// autoPullKey): which creates and adds mark, and that rm and project
// remove drop the mark again. Against real git in a temp
// SHIGOMORI_DATA_DIR.

import (
	"path/filepath"
	"strconv"
	"testing"
)

func setGlobalBool(t *testing.T, key string, on bool) {
	t.Helper()
	if code, err := runConfigSet(globalConfigScope(), key, strconv.FormatBool(on)); code != 0 || err != nil {
		t.Fatalf("config set %s: %d, %v", key, code, err)
	}
}

func autoPullMarks(t *testing.T) map[string]bool {
	t.Helper()
	return readRegistryMarkSet(autoPullKey)
}

func autoPullSandbox(t *testing.T) project {
	t.Helper()
	root := sandboxDataDir(t)
	proj, err := registerProject(seedRepo(t, root, "repo"))
	if err != nil {
		t.Fatal(err)
	}
	return proj
}

// `sm worktrees create <name>` from the primary checkout, the layer the
// autoPullNew seed lives at (createWorktree itself is policy-free).
func createViaCmd(t *testing.T, proj project, name string) worktreeIdentity {
	t.Helper()
	ctx := resolveContext(proj.Path, []project{proj})
	if code, err := cmdCreate(ctx, []string{"--no-cd", "--no-setup", name}); code != 0 || err != nil {
		t.Fatalf("create %s: %d, %v", name, code, err)
	}
	config := readProjectConfig(proj.ID)
	return autoPullIdentityAt(t, proj, filepath.Join(resolveWorktreeBase(proj.Path, config), name))
}

func autoPullIdentityAt(t *testing.T, proj project, path string) worktreeIdentity {
	t.Helper()
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range identities {
		if id.Path == path {
			return id
		}
	}
	t.Fatalf("no worktree at %s", path)
	return worktreeIdentity{}
}

func TestAutoPullNewMarksCreatedWorktree(t *testing.T) {
	proj := autoPullSandbox(t)

	off := createViaCmd(t, proj, "off")
	if autoPullMarks(t)[off.ID] {
		t.Fatalf("a create with autoPullNew unset was marked")
	}

	setGlobalBool(t, "autoPullNew", true)
	on := createViaCmd(t, proj, "on")
	if !autoPullMarks(t)[on.ID] {
		t.Fatalf("a create with autoPullNew on was not marked")
	}

	// rm drops the mark so a checkout that reappears at the same path
	// starts unmarked.
	if _, err := execRemove(proj, autoPullIdentityAt(t, proj, on.Path), removeOptions{force: true, skipCleanup: true}); err != nil {
		t.Fatal(err)
	}
	if autoPullMarks(t)[on.ID] {
		t.Fatalf("rm left the auto-pull mark behind")
	}
}

func TestAutoPullPrimaryOnlySkipsCreatedWorktrees(t *testing.T) {
	proj := autoPullSandbox(t)
	setGlobalBool(t, "autoPullNew", true)
	setGlobalBool(t, "autoPullPrimaryOnly", true)

	wt := createViaCmd(t, proj, "wt")
	if autoPullMarks(t)[wt.ID] {
		t.Fatalf("autoPullPrimaryOnly still marked a created worktree")
	}

	// The narrowing setting is nothing on its own.
	setGlobalBool(t, "autoPullNew", false)
	markAutoPullIfNew(readGlobalConfigHints(), "primary-id", true)
	if autoPullMarks(t)["primary-id"] {
		t.Fatalf("autoPullPrimaryOnly without autoPullNew marked a primary")
	}
}

func TestAutoPullNewMarksAddedProjectPrimary(t *testing.T) {
	root := sandboxDataDir(t)
	setGlobalBool(t, "autoPullNew", true)
	setGlobalBool(t, "autoPullPrimaryOnly", true)

	repo := seedRepo(t, root, "repo")
	ctx := cliContext{}
	if code, err := cmdProjectAdd(ctx, []string{repo}); code != 0 || err != nil {
		t.Fatalf("projects add: %d, %v", code, err)
	}
	primaryID := worktreeIDFromPath(repo)
	if !autoPullMarks(t)[primaryID] {
		t.Fatalf("projects add with autoPullNew on did not mark the primary")
	}

	// Remove drops it: the mark is keyed by path, so it would otherwise
	// greet a re-add of the same repo.
	projects, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	ctx = cliContext{projects: projects}
	if code, err := cmdProjectRemove(ctx, []string{"--yes", "--project-id", projects[0].ID}); code != 0 || err != nil {
		t.Fatalf("projects remove: %d, %v", code, err)
	}
	if autoPullMarks(t)[primaryID] {
		t.Fatalf("projects remove left the primary's auto-pull mark behind")
	}
}
