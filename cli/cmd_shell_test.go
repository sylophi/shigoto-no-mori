package main

// Tests for the shell-integration hook state machine: marker fences,
// ownership judgment, install/uninstall round-trips, and the emitted
// wrapper snippets (syntax-checked with the real shells when
// installed). Everything runs against a temp HOME, so no real rc
// files are ever touched.

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func sandboxHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	return home
}

func readFileT(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func TestFindHookSpan(t *testing.T) {
	guard := hookGuardLine("zsh")
	cases := []struct {
		name   string
		lines  []string
		found  bool
		broken bool
		ours   bool
	}{
		{"no markers", []string{"# rc", "export FOO=1"}, false, false, false},
		{"complete ours", []string{hookBeginMarker(), guard, hookEndMarker()}, true, false, true},
		{"inner comment still ours", []string{hookBeginMarker(), "# note", guard, hookEndMarker()}, true, false, true},
		{"vintage guard still ours",
			[]string{hookBeginMarker(), `eval "$(` + binaryName + ` shell init zsh)"`, hookEndMarker()},
			true, false, true},
		{"foreign inner line", []string{hookBeginMarker(), "export SNEAKY=1", hookEndMarker()}, true, false, false},
		{"begin without end", []string{hookBeginMarker(), guard, "# eof"}, false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			span, found, broken := findHookSpan(tc.lines)
			if found != tc.found || broken != tc.broken {
				t.Fatalf("found=%v broken=%v, want %v %v", found, broken, tc.found, tc.broken)
			}
			if found && span.ours != tc.ours {
				t.Fatalf("ours=%v, want %v", span.ours, tc.ours)
			}
		})
	}
}

func TestHookPathHonorsEnvOverrides(t *testing.T) {
	home := sandboxHome(t)
	if got, want := hookPath("zsh"), filepath.Join(home, ".zshrc"); got != want {
		t.Fatalf("zsh path %q, want %q", got, want)
	}
	zdot := filepath.Join(home, "zdot")
	t.Setenv("ZDOTDIR", zdot)
	if got, want := hookPath("zsh"), filepath.Join(zdot, ".zshrc"); got != want {
		t.Fatalf("zsh path with ZDOTDIR %q, want %q", got, want)
	}
	cfg := filepath.Join(home, "xdg")
	t.Setenv("XDG_CONFIG_HOME", cfg)
	want := filepath.Join(cfg, "fish", "conf.d", rootDirName+".fish")
	if got := hookPath("fish"); got != want {
		t.Fatalf("fish path with XDG_CONFIG_HOME %q, want %q", got, want)
	}
}

func TestInstallFreshThenUninstall(t *testing.T) {
	home := sandboxHome(t)
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	rc := filepath.Join(home, ".zshrc")
	if got, want := readFileT(t, rc), hookBlock("zsh"); got != want {
		t.Fatalf("fresh rc = %q, want the bare block %q", got, want)
	}
	if state := hookStateOf("zsh").State; state != "installed" {
		t.Fatalf("state after install = %q", state)
	}
	removed, err := uninstallHook("zsh")
	if err != nil || !removed {
		t.Fatalf("uninstall: removed=%v err=%v", removed, err)
	}
	if got := readFileT(t, rc); strings.TrimSpace(got) != "" {
		t.Fatalf("rc not emptied: %q", got)
	}
}

func TestInstallPreservesContentAndRoundTrips(t *testing.T) {
	home := sandboxHome(t)
	rc := filepath.Join(home, ".zshrc")
	// No trailing newline on purpose: install must still separate the
	// block with a blank line and uninstall must restore byte-identity.
	original := "# my prompt\nexport FOO=bar"
	if err := os.WriteFile(rc, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	after := readFileT(t, rc)
	if !strings.HasPrefix(after, "# my prompt\nexport FOO=bar\n\n"+hookBeginMarker()) {
		t.Fatalf("existing content not preserved with separator:\n%s", after)
	}
	if _, err := uninstallHook("zsh"); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	// The trailing newline the join added is acceptable. Content-wise
	// the original must survive unchanged.
	if got := strings.TrimRight(readFileT(t, rc), "\n"); got != original {
		t.Fatalf("round trip changed content:\n%q\nwant\n%q", got, original)
	}
}

func TestInstallIdempotent(t *testing.T) {
	home := sandboxHome(t)
	for range 3 {
		if err := installHook("zsh"); err != nil {
			t.Fatalf("install: %v", err)
		}
	}
	content := readFileT(t, filepath.Join(home, ".zshrc"))
	if got := strings.Count(content, hookBeginMarker()); got != 1 {
		t.Fatalf("%d begin markers after reinstalls, want 1:\n%s", got, content)
	}
}

func TestUninstallExcisesMidFileBlock(t *testing.T) {
	home := sandboxHome(t)
	rc := filepath.Join(home, ".zshrc")
	if err := os.WriteFile(rc, []byte("# top\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	appendix := "alias ll='ls -l'\n"
	f, err := os.OpenFile(rc, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(appendix); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := uninstallHook("zsh"); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if got := readFileT(t, rc); got != "# top\n"+appendix {
		t.Fatalf("mid-file excision left %q", got)
	}
}

func TestEditedBlockIsRefusedAndUntouched(t *testing.T) {
	home := sandboxHome(t)
	rc := filepath.Join(home, ".zshrc")
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	edited := strings.Replace(readFileT(t, rc),
		hookEndMarker(), "export SNEAKY=1\n"+hookEndMarker(), 1)
	if err := os.WriteFile(rc, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	if state := hookStateOf("zsh").State; state != "modified" {
		t.Fatalf("state = %q, want modified", state)
	}
	if err := installHook("zsh"); err == nil {
		t.Fatal("install over an edited block did not error")
	}
	if _, err := uninstallHook("zsh"); err == nil {
		t.Fatal("uninstall of an edited block did not error")
	}
	if got := readFileT(t, rc); got != edited {
		t.Fatalf("edited rc was touched:\n%q\nwant\n%q", got, edited)
	}
}

func TestBrokenFenceIsModified(t *testing.T) {
	home := sandboxHome(t)
	rc := filepath.Join(home, ".zshrc")
	content := hookBeginMarker() + "\nwhatever\n" // no end marker
	if err := os.WriteFile(rc, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if state := hookStateOf("zsh").State; state != "modified" {
		t.Fatalf("state = %q, want modified", state)
	}
	if err := installHook("zsh"); err == nil {
		t.Fatal("install over a broken fence did not error")
	}
	if got := readFileT(t, rc); got != content {
		t.Fatalf("broken-fence rc was touched: %q", got)
	}
}

func TestInstallPreservesPermissions(t *testing.T) {
	home := sandboxHome(t)
	rc := filepath.Join(home, ".zshrc")
	if err := os.WriteFile(rc, []byte("# rc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	info, err := os.Stat(rc)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perms changed to %o, want 600", perm)
	}
}

func TestFishInstallStatusUninstall(t *testing.T) {
	sandboxHome(t)
	if state := hookStateOf("fish").State; state != "missing" {
		t.Fatalf("initial state = %q", state)
	}
	if err := installHook("fish"); err != nil {
		t.Fatalf("install: %v", err)
	}
	if state := hookStateOf("fish").State; state != "installed" {
		t.Fatalf("state after install = %q", state)
	}
	// Wholesale replacement (marker gone) is the only thing that makes
	// the wholly-managed drop-in foreign.
	path := hookPath("fish")
	if err := os.WriteFile(path, []byte("function fish_greeting\nend\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if state := hookStateOf("fish").State; state != "modified" {
		t.Fatalf("state after replacement = %q", state)
	}
	if err := installHook("fish"); err == nil {
		t.Fatal("install over a replaced drop-in did not error")
	}
	if _, err := uninstallHook("fish"); err == nil {
		t.Fatal("uninstall of a replaced drop-in did not error")
	}
	// Restore ours, then uninstall must delete the file.
	if err := os.WriteFile(path, []byte(fishHookContent()), 0o644); err != nil {
		t.Fatal(err)
	}
	if removed, err := uninstallHook("fish"); err != nil || !removed {
		t.Fatalf("uninstall: removed=%v err=%v", removed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("drop-in still exists after uninstall")
	}
}

func TestUnreadableRcIsRefusedNotTruncated(t *testing.T) {
	home := sandboxHome(t)
	rc := filepath.Join(home, ".zshrc")
	if err := os.WriteFile(rc, []byte("# precious\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(rc, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(rc, 0o644) })
	if state := hookStateOf("zsh").State; state != "modified" {
		t.Fatalf("unreadable rc reported %q, want modified (hands off)", state)
	}
	if err := installHook("zsh"); err == nil {
		t.Fatal("install over an unreadable rc did not error")
	}
	if _, err := uninstallHook("zsh"); err == nil {
		t.Fatal("uninstall of an unreadable rc did not error")
	}
	if err := os.Chmod(rc, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readFileT(t, rc); got != "# precious\n" {
		t.Fatalf("unreadable rc was touched: %q", got)
	}
}

func TestWriteHookFileLeavesNoTempSibling(t *testing.T) {
	home := sandboxHome(t)
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	leftovers, err := filepath.Glob(filepath.Join(home, ".*tmp*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("temp siblings left behind: %v", leftovers)
	}
}

func TestHookPathBashOnDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only login-shell policy")
	}
	home := sandboxHome(t)
	// No login files: default to .bash_profile (creating it shadows
	// nothing, since none of the trio exists).
	if got, want := hookPath("bash"), filepath.Join(home, ".bash_profile"); got != want {
		t.Fatalf("empty home: %q, want %q", got, want)
	}
	// Only .profile exists: target it rather than shadowing it with a
	// new .bash_profile.
	if err := os.WriteFile(filepath.Join(home, ".profile"), []byte("# p\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, want := hookPath("bash"), filepath.Join(home, ".profile"); got != want {
		t.Fatalf(".profile only: %q, want %q", got, want)
	}
	// .bash_profile wins once present.
	if err := os.WriteFile(filepath.Join(home, ".bash_profile"), []byte("# bp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, want := hookPath("bash"), filepath.Join(home, ".bash_profile"); got != want {
		t.Fatalf("both present: %q, want %q", got, want)
	}
}

func TestLoginShellKind(t *testing.T) {
	t.Setenv("SHELL", "/bin/zsh")
	if got := loginShellKind(); got != "zsh" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("SHELL", "/usr/bin/tcsh")
	if got := loginShellKind(); got != "" {
		t.Fatalf("unsupported shell resolved to %q", got)
	}
	t.Setenv("SHELL", "")
	if got := loginShellKind(); got != "" {
		t.Fatalf("empty SHELL resolved to %q", got)
	}
}

// The emitted snippets must parse in their target shells. Runs only
// when the shell is installed (fish typically isn't on CI/macOS).
func TestWrapperSnippetSyntax(t *testing.T) {
	cases := []struct {
		kind, shell string
		checkArgs   []string
	}{
		{"zsh", "zsh", []string{"-n"}},
		{"bash", "bash", []string{"-n"}},
		{"fish", "fish", []string{"--no-execute"}},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			shellPath, err := exec.LookPath(tc.shell)
			if err != nil {
				t.Skipf("%s not installed", tc.shell)
			}
			snippet, err := wrapperSnippet(tc.kind)
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(t.TempDir(), "snippet."+tc.kind)
			if err := os.WriteFile(file, []byte(snippet), 0o644); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(shellPath, append(tc.checkArgs, file)...)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%s rejected the snippet: %v\n%s", tc.shell, err, output)
			}
		})
	}
}

func TestWrapperSnippetNamesBothCommands(t *testing.T) {
	snippet, err := wrapperSnippet("zsh")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{binaryName + "()", aliasName + "()"} {
		if !strings.Contains(snippet, name) {
			t.Fatalf("snippet missing %s:\n%s", name, snippet)
		}
	}
}
