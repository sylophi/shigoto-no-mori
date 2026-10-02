package main

import (
	"path/filepath"
	"slices"
	"testing"
)

// Pins the data dir at a path of the test's choosing. Path math only:
// nothing here touches the disk.
func pinDataDir(t *testing.T, dir string) {
	t.Helper()
	saved := cachedDataDir
	cachedDataDir = dir
	t.Cleanup(func() { cachedDataDir = saved })
}

func TestExternalVolumeRoot(t *testing.T) {
	cases := []struct{ path, want string }{
		{"/Volumes/Ext/code/repo", "/Volumes/Ext"},
		{"/Volumes/My Drive/repo", "/Volumes/My Drive"},
		{"/Users/me/code/repo", ""},
		// The mount point itself has no room beside it for a worktree
		// folder, and /Volumes alone is no drive at all.
		{"/Volumes/Ext", ""},
		{"/Volumes/Ext/", ""},
		{"/Volumes", ""},
		{"/Volumes//repo", ""},
		{"/VolumesNot/Ext/repo", ""},
	}
	for _, tc := range cases {
		if got := externalVolumeRoot(tc.path); got != tc.want {
			t.Errorf("externalVolumeRoot(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

// The expectations here are spelled the same in test/cli-reads.mts for
// the renderer's mirror (shared/git/worktreeLayout.ts).
func TestProjectDriveBase(t *testing.T) {
	const external = "/Volumes/Ext/code/repo"
	// The flavor's folder name, not the pinned data dir's.
	driveBase := "/Volumes/Ext/" + dataDirName + "/worktrees/repo"

	pinDataDir(t, "/Users/me/.sm")
	if got := projectDriveBase(external); got != driveBase {
		t.Errorf("external project: drive base = %q, want %q", got, driveBase)
	}
	// A project on the internal drive has no drive of its own to use.
	if got := projectDriveBase("/Users/me/code/repo"); got != "" {
		t.Errorf("internal project: drive base = %q, want none", got)
	}
	// With the data dir on the project's drive the managed root is
	// there already.
	pinDataDir(t, "/Volumes/Ext/stash/.sm")
	if got := projectDriveBase(external); got != "" {
		t.Errorf("data dir on the same drive: drive base = %q, want none", got)
	}
	// On another drive it is not.
	pinDataDir(t, "/Volumes/Other/.sm")
	if got := projectDriveBase(external); got != driveBase {
		t.Errorf("data dir on another drive: drive base = %q, want %q", got, driveBase)
	}
}

// The device setting moves the managed root, and only the managed
// root, onto the project's drive.
func TestResolveWorktreeBaseOnProjectDrive(t *testing.T) {
	root := sandboxDataDir(t)
	const external = "/Volumes/Ext/code/repo"
	driveBase := "/Volumes/Ext/" + dataDirName + "/worktrees/repo"
	managedRoot := filepath.Join(root, "worktrees", "repo")

	if got := resolveWorktreeBase(external, nil); got != managedRoot {
		t.Errorf("setting off: base = %q, want %q", got, managedRoot)
	}
	setGlobalBool(t, "managedOnProjectDrive", true)
	for _, config := range []*projectConfig{nil, {}, {WorktreeLayout: "managed-root"}} {
		if got := resolveWorktreeBase(external, config); got != driveBase {
			t.Errorf("setting on (config %+v): base = %q, want %q", config, got, driveBase)
		}
	}
	inProject := &projectConfig{WorktreeLayout: "in-project"}
	if got, want := resolveWorktreeBase(external, inProject), filepath.Join(external, ".shigomori", "worktrees"); got != want {
		t.Errorf("in-project layout: base = %q, want %q", got, want)
	}
	custom := &projectConfig{WorktreeLayout: "custom", CustomWorktreePath: "/Users/me/trees"}
	if got, want := resolveWorktreeBase(external, custom), "/Users/me/trees"; got != want {
		t.Errorf("custom layout: base = %q, want %q", got, want)
	}
	internal := filepath.Join(root, "code", "repo")
	if got := resolveWorktreeBase(internal, nil); got != managedRoot {
		t.Errorf("internal project: base = %q, want %q", got, managedRoot)
	}
}

// Turning the setting off again, or moving the data dir onto the
// project's drive, must not turn the worktrees already on the drive
// external, so the drive base counts as managed whatever the setting
// says and wherever the data dir is.
func TestManagedBasesIncludeProjectDrive(t *testing.T) {
	driveBase := "/Volumes/Ext/" + dataDirName + "/worktrees/repo"
	for _, dir := range []string{"/Users/me/.sm", "/Volumes/Ext/stash/.sm"} {
		pinDataDir(t, dir)
		bases := managedBasesFor("/Volumes/Ext/code/repo", nil)
		if !slices.Contains(bases, driveBase) {
			t.Errorf("data dir %s: bases %v miss the drive base", dir, bases)
		}
		if !isManagedPath(driveBase+"/otter", bases) {
			t.Errorf("data dir %s: a worktree on the drive base reads as external", dir)
		}
	}
	pinDataDir(t, "/Users/me/.sm")
	if bases := managedBasesFor("/Users/me/code/repo", nil); len(bases) != 2 {
		t.Errorf("internal project grew a drive base: %v", bases)
	}
}
