package main

// Tests for state-root resolution (initRoot): SHIGOMORI_ROOT beats the
// pointer file, the pointer file beats the flavor default, and
// malformed pointer content (blank, relative path) falls through to
// the default. Plus the state.json read guard: only an absent file
// reads as empty, so a write can never rebuild the file from a failed
// read. Everything runs against a temp HOME, so no real state root or
// config is ever touched.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// initRoot writes the package-global cachedRoot. Run it against a
// clean slate and restore whatever the process had.
func initRootT(t *testing.T) string {
	t.Helper()
	saved := cachedRoot
	cachedRoot = ""
	t.Cleanup(func() { cachedRoot = saved })
	initRoot()
	return cachedRoot
}

func writePointer(t *testing.T, configHome, content string) {
	t.Helper()
	dir := filepath.Join(configHome, rootDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "root"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// sandboxHome (cmd_shell_test.go) plus clearing the root override, so
// initRoot resolves purely from the sandboxed HOME.
func sandboxRootEnv(t *testing.T) string {
	t.Helper()
	home := sandboxHome(t)
	t.Setenv("SHIGOMORI_ROOT", "")
	return home
}

func TestInitRootDefault(t *testing.T) {
	home := sandboxRootEnv(t)
	if got, want := initRootT(t), filepath.Join(home, rootDirName); got != want {
		t.Errorf("root = %q, want %q", got, want)
	}
}

func TestInitRootPointerFile(t *testing.T) {
	home := sandboxRootEnv(t)
	target := filepath.Join(home, "Elsewhere", "sm-state")
	writePointer(t, filepath.Join(home, ".config"), target+"\n")
	if got := initRootT(t); got != target {
		t.Errorf("root = %q, want %q", got, target)
	}
}

func TestInitRootPointerTilde(t *testing.T) {
	home := sandboxRootEnv(t)
	writePointer(t, filepath.Join(home, ".config"), "~/moved-root\n")
	if got, want := initRootT(t), filepath.Join(home, "moved-root"); got != want {
		t.Errorf("root = %q, want %q", got, want)
	}
}

func TestInitRootPointerRespectsXDGConfigHome(t *testing.T) {
	home := sandboxRootEnv(t)
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	target := filepath.Join(home, "xdg-target")
	writePointer(t, configHome, target)
	// A decoy in the default location proves XDG_CONFIG_HOME wins.
	writePointer(t, filepath.Join(home, ".config"), filepath.Join(home, "decoy"))
	if got := initRootT(t); got != target {
		t.Errorf("root = %q, want %q", got, target)
	}
}

func TestInitRootPointerMalformed(t *testing.T) {
	for _, content := range []string{"", "   \n", "relative/path\n"} {
		home := sandboxRootEnv(t)
		writePointer(t, filepath.Join(home, ".config"), content)
		if got, want := initRootT(t), filepath.Join(home, rootDirName); got != want {
			t.Errorf("content %q: root = %q, want %q", content, got, want)
		}
	}
}

func TestInitRootPointerRefusesForeignDir(t *testing.T) {
	home := sandboxRootEnv(t)
	// A directory full of unrelated files (a hand-edit mistake like
	// pointing at ~/Documents) must not be adopted as the state root.
	foreign := filepath.Join(home, "documents")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "essay.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	writePointer(t, filepath.Join(home, ".config"), foreign)
	if got, want := initRootT(t), filepath.Join(home, rootDirName); got != want {
		t.Errorf("root = %q, want default %q", got, want)
	}
}

func TestInitRootPointerAcceptsExistingRoot(t *testing.T) {
	home := sandboxRootEnv(t)
	moved := filepath.Join(home, "moved-root")
	if err := os.MkdirAll(moved, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moved, "state.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writePointer(t, filepath.Join(home, ".config"), moved)
	if got := initRootT(t); got != moved {
		t.Errorf("root = %q, want %q", got, moved)
	}
}

func TestInitRootEnvBeatsPointer(t *testing.T) {
	home := sandboxRootEnv(t)
	envRoot := filepath.Join(home, "env-root")
	t.Setenv("SHIGOMORI_ROOT", envRoot)
	writePointer(t, filepath.Join(home, ".config"), filepath.Join(home, "pointer-root"))
	if got := initRootT(t); got != envRoot {
		t.Errorf("root = %q, want %q", got, envRoot)
	}
}

// --- state.json reads (store.ts readAll parity) ---

func seedState(t *testing.T, content string) {
	t.Helper()
	if err := os.WriteFile(statePath(), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The write every click makes: a use-log bump, the one that turned a
// failed read into a one-key state.json.
func bumpUseLog() error {
	return updateStateKey("projectUseLog", func(json.RawMessage) (any, error) {
		return map[string][]int64{"p1": {2}}, nil
	})
}

func TestReadStateFileMissingIsEmpty(t *testing.T) {
	sandboxConfigRoot(t)
	all, err := readStateFile()
	if err != nil || len(all) != 0 {
		t.Errorf("read of absent state.json = %v, %v, want empty", all, err)
	}
	if err := bumpUseLog(); err != nil {
		t.Errorf("write against absent state.json: %v", err)
	}
	if _, err := os.Stat(statePath()); err != nil {
		t.Errorf("write did not create state.json: %v", err)
	}
}

func TestUpdateStateKeyRefusesMalformedState(t *testing.T) {
	sandboxConfigRoot(t)
	broken := `{"projects": [{"id": "p1"`
	seedState(t, broken)
	if err := bumpUseLog(); err == nil {
		t.Error("write against malformed state.json succeeded, want error")
	}
	if raw, err := os.ReadFile(statePath()); err != nil || string(raw) != broken {
		t.Errorf("malformed state.json was rewritten to %q", raw)
	}
}

func TestUpdateStateKeyRefusesUnreadableState(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads through mode 0000")
	}
	sandboxConfigRoot(t)
	kept := `{"projects":[{"id":"p1","name":"alpha","path":"/tmp/alpha"}],` +
		`"shelvedWorktrees":{"w1":true},"projectUseLog":{"p1":[1]}}`
	seedState(t, kept)
	// The mode stays off for the whole write: restoring it first would
	// let the read succeed, which is exactly what hid the bug. The
	// directory stays writable, so the rename half of the write could
	// still land.
	if err := os.Chmod(statePath(), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(statePath(), 0o644) })
	if _, err := loadProjects(); err == nil {
		t.Error("loadProjects on unreadable state.json succeeded, want error")
	}
	if err := bumpUseLog(); err == nil {
		t.Error("write against unreadable state.json succeeded, want error")
	}
	if err := os.Chmod(statePath(), 0o644); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(statePath()); err != nil || string(raw) != kept {
		t.Errorf("unreadable state.json was rewritten to %q", raw)
	}
}
