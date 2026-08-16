package main

// Tests for state-root resolution (initRoot): SHIGOMORI_ROOT beats the
// pointer file, the pointer file beats the flavor default, and
// malformed pointer content (blank, relative path) falls through to
// the default. Everything runs against a temp HOME, so no real state
// root or config is ever touched.

import (
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
