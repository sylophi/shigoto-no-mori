package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func catalogEntry(t *testing.T, id string) launcherApp {
	t.Helper()
	for _, a := range launcherCatalog {
		if a.id == id {
			return a
		}
	}
	t.Fatalf("no catalog entry %q", id)
	return launcherApp{}
}

// A bin dir holding executables that record their arguments, one per
// line, to <name>.args beside them, and nothing else on PATH.
func fakeBin(t *testing.T, names ...string) string {
	t.Helper()
	bin := t.TempDir()
	for _, name := range names {
		script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\n"
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	return bin
}

func TestTerminalToolDetectedByItsCommand(t *testing.T) {
	vim := catalogEntry(t, "vim")
	fakeBin(t)
	if launcherAvailable(vim) {
		t.Error("vim detected with no vim on PATH")
	}
	fakeBin(t, "vim")
	if !launcherAvailable(vim) {
		t.Error("vim not detected with vim on PATH")
	}
}

func TestTerminalToolTypesItsCommandIntoTheTerminal(t *testing.T) {
	sandboxDataDir(t)
	if !launcherAvailable(catalogEntry(t, "terminal")) {
		t.Skip("no Terminal.app here")
	}
	bin := fakeBin(t, "osascript", "nvim")
	worktree := filepath.Join(t.TempDir(), "it's here")
	if err := launchDetectedApp(catalogEntry(t, "neovim"), worktree); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(bin, "osascript.args"))
	if err != nil {
		t.Fatal(err)
	}
	// The typed line is the last argument, and spans two lines.
	if want := "cd '" + strings.ReplaceAll(worktree, "'", `'\''`) + "'\nnvim .\n"; !strings.HasSuffix(string(raw), want) {
		t.Errorf("typed\n%s\nwant it to end with\n%s", raw, want)
	}
	if !strings.Contains(string(raw), `tell application "Terminal"`) {
		t.Errorf("script doesn't drive Terminal:\n%s", raw)
	}
}

// A pick with no script, or none at all here, falls back to Terminal.
func TestUnusableTerminalFallsBackToTerminal(t *testing.T) {
	sandboxDataDir(t)
	for _, pick := range []string{"hyper", "kitty"} {
		if err := os.WriteFile(configJSONPath(), []byte(`{"terminal": "`+pick+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := chosenTerminal(); got != defaultTerminal {
			t.Errorf("terminal %q: chose %q, want %q", pick, got, defaultTerminal)
		}
	}
}

func TestOpenArgsLaunchPassesTheWorktree(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, "Applications", "kitty.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := fakeBin(t, "open")
	worktree := filepath.Join(t.TempDir(), "a worktree")
	if err := launchDetectedApp(catalogEntry(t, "kitty"), worktree); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(bin, "open.args"))
	if err != nil {
		t.Fatal(err)
	}
	// A kitty in /Applications wins over the one made here.
	bundle := bundlePathFor("kitty.app")
	want := strings.Join([]string{"-n", "-a", bundle, "--args", "--single-instance", "--directory", worktree}, "\n") + "\n"
	if string(raw) != want {
		t.Errorf("open got\n%s\nwant\n%s", raw, want)
	}
}
