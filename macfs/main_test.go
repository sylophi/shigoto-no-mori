//go:build darwin

package main

import (
	"bytes"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

var fixtureTime = time.Date(2020, 1, 2, 3, 4, 5, 6000, time.UTC)

// Runs macfs with args and stdin, failing unless it exits 0, and
// returns its lines keyed by path.
func macfs(t *testing.T, stdin string, args ...string) map[string]map[string]any {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if code := run(args, strings.NewReader(stdin), &stdout, &stderr); code != 0 {
		t.Fatalf("macfs %v exited %d: %s", args, code, stderr.String())
	}
	lines := map[string]map[string]any{}
	for line := range strings.Lines(stdout.String()) {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("line %q: %v", line, err)
		}
		path := entry["path"].(string)
		if _, seen := lines[path]; seen {
			t.Fatalf("two lines for %q", path)
		}
		lines[path] = entry
	}
	return lines
}

func writeFile(t *testing.T, p, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, fixtureTime, fixtureTime); err != nil {
		t.Fatal(err)
	}
}

func errorCode(entry map[string]any) string {
	e, _ := entry["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func TestCloneKeepsModeAndMtime(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "bin/run"), "#!/bin/sh\n", 0o755)
	writeFile(t, filepath.Join(src, "pkg/a.txt"), "a\n", 0o644)
	if err := os.Symlink("a.txt", filepath.Join(src, "pkg/link")); err != nil {
		t.Fatal(err)
	}

	if err := os.Mkdir(filepath.Join(dst, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := macfs(t, "bin/run\x00pkg\x00gone", "clone", "-stdin", src, dst)
	if len(lines) != 3 || lines["bin/run"]["error"] != nil || lines["pkg"]["error"] != nil {
		t.Fatalf("lines = %v", lines)
	}
	if code := errorCode(lines["gone"]); code != "ENOENT" {
		t.Fatalf("missing source: code %q", code)
	}
	for _, rel := range []string{"bin/run", "pkg/a.txt"} {
		want, _ := os.Lstat(filepath.Join(src, rel))
		got, err := os.Lstat(filepath.Join(dst, rel))
		if err != nil {
			t.Fatal(err)
		}
		if got.Mode() != want.Mode() || !got.ModTime().Equal(fixtureTime) {
			t.Fatalf("%s: mode %v mtime %v, want %v %v", rel, got.Mode(), got.ModTime(), want.Mode(), fixtureTime)
		}
	}
	if target, err := os.Readlink(filepath.Join(dst, "pkg/link")); err != nil || target != "a.txt" {
		t.Fatalf("symlink: %q %v", target, err)
	}
}

func TestCloneWholeTree(t *testing.T) {
	src := t.TempDir()
	dst := filepath.Join(t.TempDir(), "copy")
	writeFile(t, filepath.Join(src, "a/b.txt"), "b\n", 0o600)
	lines := macfs(t, "", "clone", src, dst)
	if len(lines) != 1 || lines["."]["error"] != nil {
		t.Fatalf("lines = %v", lines)
	}
	if content, err := os.ReadFile(filepath.Join(dst, "a/b.txt")); err != nil || string(content) != "b\n" {
		t.Fatalf("clone: %q %v", content, err)
	}
}

func TestFlagsWalkAndClear(t *testing.T) {
	root := t.TempDir()
	hidden := filepath.Join(root, "dir/hidden")
	writeFile(t, hidden, "x", 0o644)
	if err := os.Symlink("hidden", filepath.Join(root, "dir/link")); err != nil {
		t.Fatal(err)
	}
	if err := chflagsNoFollow(hidden, unix.UF_HIDDEN); err != nil {
		t.Fatal(err)
	}
	// On the link itself, not its target.
	if err := chflagsNoFollow(filepath.Join(root, "dir/link"), unix.UF_IMMUTABLE); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = chflagsNoFollow(filepath.Join(root, "dir/link"), 0) })

	lines := macfs(t, "", "flags", root)
	if got := slices.Sorted(maps.Keys(lines)); !slices.Equal(got, []string{".", "dir", "dir/hidden", "dir/link"}) {
		t.Fatalf("walked %v", got)
	}
	if lines["dir/hidden"]["flags"] != float64(unix.UF_HIDDEN) || lines["dir/link"]["flags"] != float64(unix.UF_IMMUTABLE) {
		t.Fatalf("lines = %v", lines)
	}

	// Unreadable, and a fifo, which an open would block on.
	if err := os.Chmod(hidden, 0); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(root, "dir/fifo")
	if err := unix.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := chflagsNoFollow(fifo, unix.UF_HIDDEN); err != nil {
		t.Fatal(err)
	}

	macfs(t, "", "flags", "-clear", root)
	for _, rel := range []string{"dir/hidden", "dir/link", "dir/fifo"} {
		if flags, err := fileFlags(filepath.Join(root, rel)); err != nil || flags&^keptFlags != 0 {
			t.Fatalf("%s: flags %#x after clear (%v)", rel, flags, err)
		}
	}
}

func TestXattrsListAndStrip(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "f")
	writeFile(t, p, "x", 0o644)
	if err := unix.Lsetxattr(p, "com.apple.quarantine", []byte("0081;0;x;"), 0); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lsetxattr(p, "user.note", []byte("n"), 0); err != nil {
		t.Fatal(err)
	}

	names := func() []string {
		var out []string
		for _, n := range macfs(t, "f", "xattrs", "-stdin", root)["f"]["names"].([]any) {
			if n != provenanceXattr {
				out = append(out, n.(string))
			}
		}
		slices.Sort(out)
		return out
	}
	if got := names(); !slices.Equal(got, []string{"com.apple.quarantine", "user.note"}) {
		t.Fatalf("names = %v", got)
	}
	macfs(t, "", "xattrs", "-strip", root)
	if got := names(); len(got) != 0 {
		t.Fatalf("after strip: %v", got)
	}
}

// A clone shares every block with its source, so deleting it frees
// nothing.
func TestPrivateSizeOfAClone(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "source"), strings.Repeat("x", 1<<16), 0o644)
	macfs(t, "", "clone", filepath.Join(root, "source"), filepath.Join(root, "clone"))
	lines := macfs(t, "clone\x00gone", "privsize", "-stdin", root)
	if lines["clone"]["bytes"] != float64(0) {
		t.Fatalf("clone: %v", lines["clone"])
	}
	if code := errorCode(lines["gone"]); code != "ENOENT" {
		t.Fatalf("missing file: code %q", code)
	}
}

func TestFsType(t *testing.T) {
	if got := macfs(t, "", "fstype", t.TempDir())["."]["type"]; got != "apfs" {
		t.Fatalf("type = %v", got)
	}
}

func TestUnlistableDirectory(t *testing.T) {
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	writeFile(t, filepath.Join(locked, "f"), "x", 0o644)
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	var stdout, stderr bytes.Buffer
	if code := run([]string{"flags", root}, strings.NewReader(""), &stdout, &stderr); code != 0 {
		t.Fatalf("exited %d: %s", code, stderr.String())
	}
	var answered, failed bool
	for line := range strings.Lines(stdout.String()) {
		var entry map[string]any
		_ = json.Unmarshal([]byte(line), &entry)
		if entry["path"] == "locked" {
			answered = answered || entry["flags"] != nil
			failed = failed || errorCode(entry) == "EACCES"
		}
	}
	if !answered || !failed {
		t.Fatalf("locked dir: %s", stdout.String())
	}
}

func TestUsageErrors(t *testing.T) {
	for _, args := range [][]string{{}, {"nope", "/"}, {"clone", "/"}, {"flags"}, {"flags", "-bogus", "/"}} {
		if code := run(args, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
}
