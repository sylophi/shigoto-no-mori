//go:build darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

// Clones `base` from `source` into a new worktree of `repo` and holds
// it to a plain checkout. Returns the report and the worktree.
func cloneAndCompare(t *testing.T, repo, source, base string) (cloneCheckoutReport, string) {
	t.Helper()
	wt := filepath.Join(t.TempDir(), "clone")
	if err := gitWorktreeAdd(repo, wt, "clone-"+filepath.Base(filepath.Dir(wt)), base, true); err != nil {
		t.Fatal(err)
	}
	report, err := cloneCheckout(source, wt)
	if err != nil {
		t.Fatal(err)
	}
	assertSameAsPlainCheckout(t, repo, wt, base)
	return report, wt
}

// Ages the checkout's files and refreshes its index, as a checkout that
// has sat for a while is (so a clone keeps a telling mtime).
func ageCheckout(t *testing.T, checkout string) {
	t.Helper()
	err := filepath.WalkDir(checkout, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		return os.Chtimes(p, cloneFixtureTime, cloneFixtureTime)
	})
	if err != nil {
		t.Fatal(err)
	}
	runGitT(t, checkout, "update-index", "-q", "--refresh")
}

func wasCloned(t *testing.T, path string) bool {
	t.Helper()
	info, err := os.Lstat(path)
	return err == nil && info.ModTime().Equal(cloneFixtureTime)
}

func TestCloneCheckoutSHA256Repo(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	deterministicGitEnv(t)
	repo := filepath.Join(t.TempDir(), "repo")
	runGitT(t, filepath.Dir(repo), "init", "-q", "-b", "main", "--object-format=sha256", repo)
	writeFileT(t, filepath.Join(repo, "src/a.go"), "package a\n")
	writeFileT(t, filepath.Join(repo, "README.md"), "readme\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "c")
	ageCheckout(t, repo)
	report, wt := cloneAndCompare(t, repo, repo, "main")
	if report.Cloned != 2 || !wasCloned(t, filepath.Join(wt, "src/a.go")) {
		t.Fatalf("report = %+v", report)
	}
}

func TestCloneCheckoutIndexVersion4Source(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	runGitT(t, repo, "update-index", "--index-version", "4")
	report, wt := cloneAndCompare(t, repo, repo, "main")
	if report.Cloned == 0 || !wasCloned(t, filepath.Join(wt, "pure/sub/two.md")) {
		t.Fatalf("report = %+v", report)
	}
}

// A source mid-merge: the conflicted path goes to git, the rest clones.
func TestCloneCheckoutConflictedSource(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := seedRepo(t, t.TempDir(), "repo")
	writeFileT(t, filepath.Join(repo, "f.txt"), "base\n")
	writeFileT(t, filepath.Join(repo, "keep/k.txt"), "keep\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "base")
	runGitT(t, repo, "checkout", "-q", "-b", "side")
	writeFileT(t, filepath.Join(repo, "f.txt"), "side\n")
	runGitT(t, repo, "commit", "-q", "-am", "side")
	runGitT(t, repo, "checkout", "-q", "main")
	writeFileT(t, filepath.Join(repo, "f.txt"), "main\n")
	runGitT(t, repo, "commit", "-q", "-am", "main")
	ageCheckout(t, repo)
	if _, err := runGit(repo, "merge", "-q", "side"); err == nil {
		t.Fatal("merge should conflict")
	}
	report, wt := cloneAndCompare(t, repo, repo, "main")
	if !wasCloned(t, filepath.Join(wt, "keep/k.txt")) || wasCloned(t, filepath.Join(wt, "f.txt")) {
		t.Fatalf("report = %+v", report)
	}
}

// A bare repo has no primary: the sibling on the base branch is the
// source, through the real create path.
func TestCreateClonesFromSiblingOfBareRepo(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	root := sandboxDataDir(t)
	src := seedRepo(t, root, "src")
	writeFileT(t, filepath.Join(src, "lib/x.go"), "package lib\n")
	runGitT(t, src, "add", ".")
	runGitT(t, src, "commit", "-q", "-m", "files")
	bare := filepath.Join(root, "repo.git")
	runGitT(t, root, "clone", "-q", "--bare", src, bare)
	sibling := filepath.Join(root, "wt-main")
	runGitT(t, bare, "worktree", "add", "-q", sibling, "main")
	ageCheckout(t, sibling)
	proj, err := registerProject(bare)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := createWorktree(proj, "fresh", "fresh", "main", false, true)
	if err != nil {
		t.Fatal(err)
	}
	if !wasCloned(t, filepath.Join(wt.Path, "lib/x.go")) {
		t.Fatal("lib/x.go wasn't cloned from the sibling")
	}
	assertSameAsPlainCheckout(t, bare, wt.Path, "main")
}

// Sources only git can lay out (sparse, split index) fall back to
// git's own checkout, through the real create path.
func TestCreateFallsBackForSparseAndSplitIndex(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, repo string)
	}{
		{"sparse", func(t *testing.T, repo string) {
			runGitT(t, repo, "sparse-checkout", "set", "src")
		}},
		{"split index", func(t *testing.T, repo string) {
			runGitT(t, repo, "config", "core.splitIndex", "true")
			runGitT(t, repo, "update-index", "--split-index")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := sandboxDataDir(t)
			repo := seedRepo(t, root, "repo")
			writeFileT(t, filepath.Join(repo, "src/a.go"), "package a\n")
			writeFileT(t, filepath.Join(repo, "docs/d.md"), "docs\n")
			runGitT(t, repo, "add", ".")
			runGitT(t, repo, "commit", "-q", "-m", "files")
			ageCheckout(t, repo)
			tc.setup(t, repo)
			if blocker := projectCloneBlocker(repo); blocker == "" {
				t.Fatal("no blocker")
			}
			proj, err := registerProject(repo)
			if err != nil {
				t.Fatal(err)
			}
			wt, err := createWorktree(proj, "fresh", "fresh", "main", false, true)
			if err != nil {
				t.Fatal(err)
			}
			if wasCloned(t, filepath.Join(wt.Path, "src/a.go")) {
				t.Fatal("cloned despite the blocker")
			}
			assertSameAsPlainCheckout(t, repo, wt.Path, "main")
		})
	}
}

// A submodule populated in the source stays out of the clone: the new
// worktree gets the empty directory a checkout leaves.
func TestCloneCheckoutPopulatedSubmodule(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	root := t.TempDir()
	sub := seedRepo(t, root, "sub")
	writeFileT(t, filepath.Join(sub, "inside.txt"), "inside\n")
	runGitT(t, sub, "add", ".")
	runGitT(t, sub, "commit", "-q", "-m", "sub")
	repo := seedRepo(t, root, "repo")
	writeFileT(t, filepath.Join(repo, "vendor/other.txt"), "other\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub")
	runGitT(t, repo, "commit", "-q", "-m", "with submodule")
	ageCheckout(t, repo)
	_, wt := cloneAndCompare(t, repo, repo, "main")
	if entries, err := os.ReadDir(filepath.Join(wt, "vendor/sub")); err != nil || len(entries) != 0 {
		t.Fatalf("vendor/sub = %v, %v, want an empty directory", entries, err)
	}
}

// A repo nested in a tracked directory (untracked, so the directory
// can't be cloned whole) doesn't come along.
func TestCloneCheckoutLeavesNestedRepoBehind(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	runGitT(t, repo, "init", "-q", filepath.Join(repo, "pure/nested"))
	writeFileT(t, filepath.Join(repo, "pure/nested/file"), "nested\n")
	report, wt := cloneAndCompare(t, repo, repo, "main")
	if report.Cloned == 0 {
		t.Fatalf("report = %+v", report)
	}
	if _, err := os.Lstat(filepath.Join(wt, "pure/nested")); !os.IsNotExist(err) {
		t.Fatalf("nested repo came along: %v", err)
	}
}

// Files a checkout wouldn't leave as the source has them: odd
// permissions, a quarantine attribute, a file flag. Each goes to git, so the clone matches a plain
// checkout down to the mode.
func TestCloneCheckoutLeavesOddFilesToGit(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	for _, step := range []struct {
		path string
		do   func(p string) error
	}{
		{"pure/one.txt", func(p string) error { return os.Chmod(p, 0o444) }},
		{"docs/y.md", func(p string) error { return os.Chmod(p, 0o664) }},
		{"src/a.go", func(p string) error {
			return unix.Setxattr(p, "com.apple.quarantine", []byte("0081;00000000;Safari;"), 0)
		}},
		{"README.md", func(p string) error { return unix.Chflags(p, unix.UF_HIDDEN) }},
	} {
		if err := step.do(filepath.Join(repo, step.path)); err != nil {
			t.Fatal(err)
		}
	}
	// Have the index vouch for them as they are now (git's own refresh
	// only compares whole seconds and could miss a change this quick),
	// so only the checks for what a checkout leaves turn them down.
	for _, p := range []string{"pure/one.txt", "docs/y.md", "src/a.go", "README.md"} {
		runGitT(t, repo, "rm", "-q", "--cached", "--", p)
		runGitT(t, repo, "add", "--", p)
	}
	_, wt := cloneAndCompare(t, repo, repo, "main")
	for _, p := range []string{"pure/one.txt", "docs/y.md", "src/a.go", "README.md"} {
		if wasCloned(t, filepath.Join(wt, p)) {
			t.Errorf("%s was cloned", p)
		}
	}
	var buf [256]byte
	n, _ := unix.Listxattr(filepath.Join(wt, "src/a.go"), buf[:])
	if strings.Contains(string(buf[:n]), "quarantine") {
		t.Error("quarantine came along")
	}
	var st unix.Stat_t
	if unix.Lstat(filepath.Join(wt, "README.md"), &st) != nil || st.Flags&unix.UF_HIDDEN != 0 {
		t.Error("the hidden flag came along")
	}
}

// Re-records files in the source's index as they are on disk now
// (a refresh skips changes made within the second it last looked).
func reAddT(t *testing.T, repo string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		runGitT(t, repo, "rm", "-q", "--cached", "--", p)
		runGitT(t, repo, "add", "--", p)
	}
}

// The source wrote its file through a filter the target's commit
// doesn't have: same blob, same size, other bytes.
func TestCloneCheckoutSourceOnlyFilter(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := seedRepo(t, t.TempDir(), "repo")
	runGitT(t, repo, "config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'")
	runGitT(t, repo, "config", "filter.upper.smudge", "tr '[:lower:]' '[:upper:]'")
	writeFileT(t, filepath.Join(repo, "f.txt"), "hello\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "plain")
	runGitT(t, repo, "branch", "plain")
	writeFileT(t, filepath.Join(repo, ".gitattributes"), "f.txt filter=upper\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "filtered")
	// Check f.txt out again through the filter, then let it age.
	runGitT(t, repo, "rm", "-q", "--cached", "f.txt")
	runGitT(t, repo, "reset", "-q", "--hard")
	if got := readFileT(t, filepath.Join(repo, "f.txt")); got != "HELLO\n" {
		t.Fatalf("source f.txt = %q", got)
	}
	ageCheckout(t, repo)
	cloneAndCompare(t, repo, repo, "plain")
}

// Every spelling git takes for true turns CRLF on at checkout.
func TestCloneCheckoutAutocrlfSpellings(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	for _, v := range []string{"yes", "on", "1", "TRUE", "1k", "(bare key)"} {
		t.Run(v, func(t *testing.T) {
			repo := cloneFixture(t)
			if v == "(bare key)" {
				f, err := os.OpenFile(filepath.Join(repo, ".git/config"), os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = f.WriteString("[core]\n\tautocrlf\n")
				f.Close()
			} else {
				runGitT(t, repo, "config", "core.autocrlf", v)
			}
			cloneAndCompare(t, repo, repo, "main")
		})
	}
}

func TestCloneCheckoutWithoutSymlinks(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	// An empty value is false to git, not unset.
	for _, v := range []string{"false", ""} {
		t.Run(v, func(t *testing.T) {
			repo := cloneFixture(t)
			runGitT(t, repo, "config", "core.symlinks", v)
			cloneAndCompare(t, repo, repo, "main")
		})
	}
}

// A replacement blob changes what a checkout writes, which only git knows.
func TestCreateFallsBackForReplaceRefs(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "repo")
	writeFileT(t, filepath.Join(repo, "f.txt"), "hello\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "c")
	ageCheckout(t, repo)
	blob := strings.TrimSpace(gitOut(t, repo, "rev-parse", "HEAD:f.txt"))
	other, err := runGitStdin(repo, nil, "HELLO\n", "hash-object", "-w", "--stdin")
	if err != nil {
		t.Fatal(err)
	}
	runGitT(t, repo, "replace", blob, strings.TrimSpace(other))
	if blocker := projectCloneBlocker(repo); blocker != "replace refs" {
		t.Fatalf("blocker = %q", blocker)
	}
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := createWorktree(proj, "fresh", "fresh", "main", false, true)
	if err != nil {
		t.Fatal(err)
	}
	assertSameAsPlainCheckout(t, repo, wt.Path, "main")
}

// The hook sees what it sees under `git worktree add`: the same cwd,
// arguments and git environment (no GIT_DIR).
func TestCloneCheckoutHookEnvironmentMatchesGit(t *testing.T) {
	repo := cloneFixture(t)
	logDir := t.TempDir()
	writeFileT(t, filepath.Join(repo, ".git/hooks/post-checkout"),
		"#!/bin/sh\nname=$(basename \"$PWD\")\n"+
			"{ echo \"$@\"; echo \"cwd $PWD\"; env | grep '^GIT_' | sort; echo \"path ${PATH%%:*}\"; } > '"+logDir+"'/$name\n")
	if err := os.Chmod(filepath.Join(repo, ".git/hooks/post-checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Dir(repo)
	runGitT(t, repo, "worktree", "add", "-q", "-b", "p", filepath.Join(parent, "plain"), "main")
	wt := filepath.Join(parent, "clone")
	if err := gitWorktreeAdd(repo, wt, "c", "main", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	plain := strings.ReplaceAll(readFileT(t, filepath.Join(logDir, "plain")), "/plain", "/WT")
	clone := strings.ReplaceAll(readFileT(t, filepath.Join(logDir, "clone")), "/clone", "/WT")
	if plain != clone {
		t.Fatalf("hook saw\n%s\nunder git, and\n%s\nhere", plain, clone)
	}
}

// An immutable file in the source: its clone is turned down and git
// writes it, with no flag left to trip over.
func TestCloneCheckoutImmutableSourceFile(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	locked := filepath.Join(repo, "pure/one.txt")
	if err := unix.Chflags(locked, unix.UF_IMMUTABLE); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Chflags(locked, 0) })
	reAddT(t, repo, "pure/one.txt")
	_, wt := cloneAndCompare(t, repo, repo, "main")
	var st unix.Stat_t
	if err := unix.Lstat(filepath.Join(wt, "pure/one.txt"), &st); err != nil || st.Flags&unix.UF_IMMUTABLE != 0 {
		t.Fatalf("pure/one.txt: %v, flags %#x", err, st.Flags)
	}
}

// A directory cloned whole sheds what a checkout wouldn't give it.
func TestCloneCheckoutStripsDirectoryMetadata(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	dir := filepath.Join(repo, "pure/sub")
	if err := unix.Setxattr(dir, "com.example.marker", []byte("x"), 0); err != nil {
		t.Fatal(err)
	}
	if err := unix.Chflags(dir, unix.UF_HIDDEN); err != nil {
		t.Fatal(err)
	}
	_, wt := cloneAndCompare(t, repo, repo, "main")
	if !wasCloned(t, filepath.Join(wt, "pure/sub/two.md")) {
		t.Fatal("pure/sub wasn't cloned")
	}
	var buf [256]byte
	n, _ := unix.Llistxattr(filepath.Join(wt, "pure/sub"), buf[:])
	var st unix.Stat_t
	if strings.Contains(string(buf[:n]), "marker") || unix.Lstat(filepath.Join(wt, "pure/sub"), &st) != nil || st.Flags != 0 {
		t.Fatalf("pure/sub kept %q, flags %#x", buf[:n], st.Flags)
	}
}

// The source has a file (or a symlink) where the commit has a
// directory: nothing under it can be cloned, and git writes it all.
func TestCloneCheckoutSourceDirectoryReplaced(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	for dir, replace := range map[string]func(string) error{
		"docs":     func(p string) error { return os.WriteFile(p, []byte("now a file\n"), 0o644) },
		"src/deep": func(p string) error { return os.Symlink("..", p) },
	} {
		p := filepath.Join(repo, dir)
		if err := os.RemoveAll(p); err != nil {
			t.Fatal(err)
		}
		if err := replace(p); err != nil {
			t.Fatal(err)
		}
	}
	// main clones docs whole. other changes docs/y.md, so its docs/x.md
	// is cloned on its own, through a path that's no longer a directory.
	for _, base := range []string{"main", "other"} {
		cloneAndCompare(t, repo, repo, base)
	}
}

// A file hashed through a filter whose attribute is gone since: git
// still calls it clean, and only its bytes tell. With a filter driver
// configured, every clone is hashed, whatever the driver is named.
func TestCloneCheckoutFilterRemovedSinceHashed(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	for _, driver := range []string{"lower", "LFS", "lfs"} {
		t.Run(driver, func(t *testing.T) {
			repo := seedRepo(t, t.TempDir(), "repo")
			runGitT(t, repo, "config", "filter."+driver+".clean", "tr '[:upper:]' '[:lower:]'")
			writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "f filter="+driver+"\n")
			writeFileT(t, filepath.Join(repo, "f"), "HELLO\n")
			writeFileT(t, filepath.Join(repo, "g"), "plain\n")
			runGitT(t, repo, "add", ".")
			runGitT(t, repo, "commit", "-q", "-m", "c")
			ageCheckout(t, repo)
			if err := os.Remove(filepath.Join(repo, ".git/info/attributes")); err != nil {
				t.Fatal(err)
			}
			report, wt := cloneAndCompare(t, repo, repo, "main")
			// Hashing turns down only what doesn't match.
			if report.Hashed == 0 || !wasCloned(t, filepath.Join(wt, "g")) || report.Cloned != 1 {
				t.Fatalf("report = %+v", report)
			}
		})
	}
}

// The same with a working-tree encoding, still in use on another path:
// UTF-16 bytes the size of the UTF-8 blob.
func TestCloneCheckoutEncodingRemovedSinceHashed(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := seedRepo(t, t.TempDir(), "repo")
	writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "f working-tree-encoding=UTF-16BE\n")
	writeFileT(t, filepath.Join(repo, "f"), "\x00\xe9")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "c")
	ageCheckout(t, repo)
	writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "elsewhere working-tree-encoding=UTF-16BE\n")
	report, _ := cloneAndCompare(t, repo, repo, "main")
	if report.Hashed == 0 {
		t.Fatalf("report = %+v", report)
	}
}

func TestCloneCheckoutImmutableSymlink(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	link := filepath.Join(repo, "link")
	if err := chflagsNoFollow(link, unix.UF_IMMUTABLE); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = chflagsNoFollow(link, 0) })
	reAddT(t, repo, "link")
	cloneAndCompare(t, repo, repo, "main")
}

// A hook script without a #! line runs, through sh, as under git.
func TestCloneCheckoutHookWithoutShebang(t *testing.T) {
	repo := cloneFixture(t)
	log := filepath.Join(t.TempDir(), "log")
	writeFileT(t, filepath.Join(repo, ".git/hooks/post-checkout"), "echo \"ran $3\" >> '"+log+"'\n")
	if err := os.Chmod(filepath.Join(repo, ".git/hooks/post-checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(filepath.Dir(repo), "clone")
	if err := gitWorktreeAdd(repo, wt, "c", "main", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	if got := readFileT(t, log); got != "ran 1\n" {
		t.Fatalf("log = %q", got)
	}
}

// Hooks set in config run too, in git's order and with the environment
// `git worktree add` gives them: a hook's git command in another
// repository reaches that repository.
func TestCloneCheckoutConfigHooksMatchGit(t *testing.T) {
	repo := cloneFixture(t)
	other := seedRepo(t, t.TempDir(), "other")
	runGitT(t, other, "branch", "only-other")
	logDir := t.TempDir()
	script := filepath.Join(logDir, "audit.sh")
	writeFileT(t, script, "#!/bin/sh\ngit -C '"+other+"' rev-parse -q --verify only-other >/dev/null || exit 9\n"+
		"echo \"audit $# $*\" >> \"$PWD.log\"\n")
	if err := os.Chmod(script, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitT(t, repo, "config", "hook.audit.event", "post-checkout")
	runGitT(t, repo, "config", "hook.audit.command", script+" --flag")
	runGitT(t, repo, "config", "hook.second.event", "post-checkout")
	runGitT(t, repo, "config", "hook.second.command", `echo "second $1" >> "$PWD.log"`)
	writeFileT(t, filepath.Join(repo, ".git/hooks/post-checkout"), "#!/bin/sh\necho \"hookdir $*\" >> \"$PWD.log\"\n")
	if err := os.Chmod(filepath.Join(repo, ".git/hooks/post-checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Dir(repo)
	runGitT(t, repo, "worktree", "add", "-q", "-b", "p", filepath.Join(parent, "plain"), "main")
	wt := filepath.Join(parent, "clone")
	if err := gitWorktreeAdd(repo, wt, "c", "main", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	plain, clone := readFileT(t, filepath.Join(parent, "plain.log")), readFileT(t, filepath.Join(parent, "clone.log"))
	if plain != clone || strings.Count(plain, "\n") != 3 {
		t.Fatalf("hooks wrote\n%s\nunder git, and\n%s\nhere", plain, clone)
	}
}

// Clones `base` from the source into a fresh worktree, holds it to a
// plain checkout, and returns how many clones were read back.
func cloneHashedT(t *testing.T, repo, base string) int {
	t.Helper()
	report, _ := cloneAndCompare(t, repo, repo, base)
	return report.Hashed
}

// A change to the attributes reads back every file git last checked
// before it, once: the proof holds for later clones, and through later
// attribute changes, until a file changes.
func TestCloneCheckoutVerifiesAfterAttributesChange(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	sandboxDataDir(t)
	repo := seedRepo(t, t.TempDir(), "repo")
	writeFileT(t, filepath.Join(repo, ".gitattributes"), "*.md text\n")
	for _, p := range []string{"a.md", "src/b.go", "src/c.txt"} {
		writeFileT(t, filepath.Join(repo, p), p+"\n")
	}
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "c")
	// Files git checked after everything else in the tree last changed.
	ageCheckout(t, repo)
	if n := cloneHashedT(t, repo, "main"); n != 0 {
		t.Fatalf("hashed %d with nothing changed since git checked them", n)
	}
	f, err := os.OpenFile(filepath.Join(repo, ".gitattributes"), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("*.none text\n")
	f.Close()
	// .gitattributes itself is now dirty, so git writes it. The other
	// three are read back.
	if n := cloneHashedT(t, repo, "main"); n != 3 {
		t.Fatalf("hashed %d after the attributes changed, want 3", n)
	}
	if n := cloneHashedT(t, repo, "main"); n != 0 {
		t.Fatalf("hashed %d again, after the first clone proved them", n)
	}
	// Another change: the proof stands for the files as they are.
	writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "*.none text\n")
	if n := cloneHashedT(t, repo, "main"); n != 0 {
		t.Fatalf("hashed %d, with every file proven already", n)
	}
	// A file that changes is new to the record.
	writeFileT(t, filepath.Join(repo, "src/c.txt"), "changed\n")
	runGitT(t, repo, "add", "src/c.txt")
	runGitT(t, repo, "commit", "-q", "-m", "changed")
	if err := os.Chtimes(filepath.Join(repo, "src/c.txt"), cloneFixtureTime, cloneFixtureTime); err != nil {
		t.Fatal(err)
	}
	reAddT(t, repo, "src/c.txt")
	writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "*.other text\n")
	if n := cloneHashedT(t, repo, "main"); n != 1 {
		t.Fatalf("hashed %d, want just the changed file", n)
	}
}

// Where attributes live outside the tree, a change there counts too,
// and so does a tracked .gitattributes gone from disk.
func TestCloneCheckoutAttributeSources(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	global := filepath.Join(t.TempDir(), "attributes")
	for _, tc := range []struct {
		name   string
		change func(t *testing.T, repo string)
		want   int // files read back, or 0 for any
	}{
		{"info written", func(t *testing.T, repo string) {
			writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "*.none text\n")
		}, 0},
		{"info deleted", func(t *testing.T, repo string) {
			if err := os.Remove(filepath.Join(repo, ".git/info/attributes")); err != nil {
				t.Fatal(err)
			}
		}, 0},
		{"global edited", func(t *testing.T, repo string) {
			writeFileT(t, global, "*.none text\n")
		}, 0},
		{"tracked deleted", func(t *testing.T, repo string) {
			if err := os.Remove(filepath.Join(repo, ".gitattributes")); err != nil {
				t.Fatal(err)
			}
		}, 0},
		// A folder's own attributes reach only what's under it: src's
		// two files and its .gitattributes, edited and so dirty, which
		// git writes.
		{"nested edited", func(t *testing.T, repo string) {
			writeFileT(t, filepath.Join(repo, "src/.gitattributes"), "*.go text\n*.none text\n")
		}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sandboxDataDir(t)
			// Every attributes source first, then the files git checks.
			repo := seedRepo(t, t.TempDir(), "repo")
			writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "")
			writeFileT(t, global, "")
			runGitT(t, repo, "config", "core.attributesFile", global)
			writeFileT(t, filepath.Join(repo, ".gitattributes"), "*.md text\n")
			writeFileT(t, filepath.Join(repo, "src/.gitattributes"), "*.go text\n")
			for _, p := range []string{"a.md", "src/b.go", "src/deep/c.txt"} {
				writeFileT(t, filepath.Join(repo, p), p+"\n")
			}
			runGitT(t, repo, "add", ".")
			runGitT(t, repo, "commit", "-q", "-m", "c")
			ageCheckout(t, repo)
			cloneHashedT(t, repo, "main")
			if n := cloneHashedT(t, repo, "main"); n != 0 {
				t.Fatalf("hashed %d before any change", n)
			}
			tc.change(t, repo)
			if n := cloneHashedT(t, repo, "main"); n == 0 || (tc.want != 0 && n != tc.want) {
				t.Fatalf("read back %d, want %d", n, tc.want)
			}
		})
	}
}

// A record that can't be read is no record: the files are read back.
func TestCloneCheckoutCorruptRecord(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	sandboxDataDir(t)
	repo := cloneFixture(t)
	writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "*.none text\n")
	if n := cloneHashedT(t, repo, "main"); n == 0 {
		t.Fatal("nothing read back")
	}
	writeFileT(t, cloneVerifiedPath(repo), "{not json")
	if n := cloneHashedT(t, repo, "main"); n == 0 {
		t.Fatal("trusted a record it couldn't read")
	}
	if n := cloneHashedT(t, repo, "main"); n != 0 {
		t.Fatalf("hashed %d once the record was rewritten", n)
	}
}

// Attributes changed mid-clone: the conversion checks went by the old
// ones, so the clone gives way to git's checkout under the new ones.
func TestCloneCheckoutAttributesChangeMidClone(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	native := cloneTree
	t.Cleanup(func() { cloneTree = native })
	var once sync.Once
	cloneTree = func(src, dst string) error {
		once.Do(func() {
			writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "*.md filter=upper\n")
		})
		return native(src, dst)
	}
	wt := filepath.Join(filepath.Dir(repo), "clone")
	if err := gitWorktreeAdd(repo, wt, "clone", "main", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	assertSameAsPlainCheckout(t, repo, wt, "main")
	// Through the filter: git's checkout, not a clone.
	if got := readFileT(t, filepath.Join(wt, "README.md")); got != "README\n" {
		t.Fatalf("README.md = %q", got)
	}
}

// A file recorded through a filter set in a .gitattributes that is
// then gone without a trace in any attributes file: deleted untracked,
// removed in a commit, or by a branch switch. Its folder changed, so
// the file is read back.
func TestCloneCheckoutAttributesFileGone(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	for _, how := range []string{"untracked", "commit", "branch switch"} {
		t.Run(how, func(t *testing.T) {
			sandboxDataDir(t)
			repo := seedRepo(t, t.TempDir(), "repo")
			runGitT(t, repo, "config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'")
			writeFileT(t, filepath.Join(repo, "f.txt"), "hello\n")
			writeFileT(t, filepath.Join(repo, "g.txt"), "plain\n")
			runGitT(t, repo, "add", ".")
			runGitT(t, repo, "commit", "-q", "-m", "files")
			runGitT(t, repo, "branch", "files")
			writeFileT(t, filepath.Join(repo, ".gitattributes"), "f.txt filter=upper\n")
			if how != "untracked" {
				runGitT(t, repo, "add", ".gitattributes")
				runGitT(t, repo, "commit", "-q", "-m", "attributes")
			}
			// Recorded through the filter: HELLO on disk for blob hello.
			writeFileT(t, filepath.Join(repo, "f.txt"), "HELLO\n")
			ageCheckout(t, repo)
			reAddT(t, repo, "f.txt")
			switch how {
			case "untracked":
				if err := os.Remove(filepath.Join(repo, ".gitattributes")); err != nil {
					t.Fatal(err)
				}
			case "commit":
				runGitT(t, repo, "rm", "-q", ".gitattributes")
				runGitT(t, repo, "commit", "-q", "-m", "drop attributes")
			case "branch switch":
				runGitT(t, repo, "checkout", "-q", "files")
			}
			base := strings.TrimSpace(gitOut(t, repo, "rev-parse", "--abbrev-ref", "HEAD"))
			report, _ := cloneAndCompare(t, repo, repo, base)
			if report.Hashed == 0 {
				t.Fatalf("report = %+v", report)
			}
		})
	}
}

// A plain repo whose files git checked after everything above them
// last changed: nothing in it needs reading back.
func settledRepoT(t *testing.T) string {
	t.Helper()
	repo := seedRepo(t, t.TempDir(), "repo")
	runGitT(t, repo, "config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'")
	for _, p := range []string{"f.txt", "keep/a.txt", "keep/b.txt", "pure/one.txt"} {
		writeFileT(t, filepath.Join(repo, p), "hello\n")
	}
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "files")
	ageCheckout(t, repo)
	return repo
}

// An in-place edit mid-clone (no folder changes) on a file that needs
// no reading back: the stat check alone turns it down.
func TestCloneCheckoutEditMidCloneSettledRepo(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	sandboxDataDir(t)
	repo := settledRepoT(t)
	native := cloneTree
	t.Cleanup(func() { cloneTree = native })
	var once sync.Once
	cloneTree = func(src, dst string) error {
		once.Do(func() {
			f, err := os.OpenFile(filepath.Join(repo, "keep/a.txt"), os.O_WRONLY, 0)
			if err == nil {
				_, _ = f.WriteString("HELLO")
				f.Close()
			}
		})
		return native(src, dst)
	}
	report, wt := cloneAndCompare(t, repo, repo, "main")
	if report.Hashed != 0 || report.Cloned == 0 {
		t.Fatalf("report = %+v", report)
	}
	if got := readFileT(t, filepath.Join(wt, "keep/a.txt")); got != "hello\n" {
		t.Fatalf("keep/a.txt = %q", got)
	}
}

// A file renamed on disk to another case: a folder clone takes the
// disk's spelling, and the result has git's.
func TestCloneCheckoutCaseRenamedOnDisk(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	sandboxDataDir(t)
	repo := settledRepoT(t)
	if err := os.Rename(filepath.Join(repo, "pure/one.txt"), filepath.Join(repo, "pure/One.txt")); err != nil {
		t.Fatal(err)
	}
	// Re-recorded under git's spelling (git add would take the disk's):
	// an entry with no stat, which the refresh hashes and fills in.
	oid := strings.TrimSpace(gitOut(t, repo, "rev-parse", ":pure/one.txt"))
	runGitT(t, repo, "update-index", "--cacheinfo", "100644,"+oid+",pure/one.txt")
	runGitT(t, repo, "update-index", "-q", "--refresh")
	if got := gitOut(t, repo, "ls-files", "pure"); got != "pure/one.txt\n" {
		t.Fatalf("index has %q", got)
	}
	report, wt := cloneAndCompare(t, repo, repo, "main")
	if report.Cloned == 0 {
		t.Fatalf("report = %+v", report)
	}
	entries, err := os.ReadDir(filepath.Join(wt, "pure"))
	if err != nil || len(entries) != 1 || entries[0].Name() != "one.txt" {
		t.Fatalf("pure holds %v (%v)", entries, err)
	}
}

// A proven file re-recorded through a filter keeps its blob but not its
// bytes: the record is for the file as it was, so it's read back again.
func TestCloneCheckoutRecordFollowsTheFile(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	sandboxDataDir(t)
	repo := settledRepoT(t)
	// Something above f.txt changes, so it's read back and proven.
	writeFileT(t, filepath.Join(repo, "new.txt"), "untracked\n")
	if n := cloneHashedT(t, repo, "main"); n == 0 {
		t.Fatal("nothing read back")
	}
	// Recorded again through the filter: HELLO on disk, the same blob.
	writeFileT(t, filepath.Join(repo, ".git/info/attributes"), "f.txt filter=upper\n")
	writeFileT(t, filepath.Join(repo, "f.txt"), "HELLO\n")
	if err := os.Chtimes(filepath.Join(repo, "f.txt"), cloneFixtureTime, cloneFixtureTime); err != nil {
		t.Fatal(err)
	}
	reAddT(t, repo, "f.txt")
	if err := os.Remove(filepath.Join(repo, ".git/info/attributes")); err != nil {
		t.Fatal(err)
	}
	if n := cloneHashedT(t, repo, "main"); n == 0 {
		t.Fatal("trusted a record of the file as it was")
	}
}

// The attributes that applied when git last checked a file change with
// config alone: core.attributesFile pointed elsewhere, or a relative one
// (resolved from the checkout) edited.
func TestCloneCheckoutAttributesFileConfig(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	for _, how := range []string{"repointed", "relative edited"} {
		t.Run(how, func(t *testing.T) {
			sandboxDataDir(t)
			repo := seedRepo(t, t.TempDir(), "repo")
			runGitT(t, repo, "config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'")
			// An older attributes file with nothing in it, for later.
			plainAttrs := filepath.Join(t.TempDir(), "plain-attrs")
			writeFileT(t, plainAttrs, "")
			writeFileT(t, filepath.Join(repo, ".git/info/custom-attrs"), "f.txt filter=upper\n")
			runGitT(t, repo, "config", "core.attributesFile", ".git/info/custom-attrs")
			writeFileT(t, filepath.Join(repo, "f.txt"), "hello\n")
			runGitT(t, repo, "add", ".")
			runGitT(t, repo, "commit", "-q", "-m", "c")
			// Recorded through the filter: HELLO on disk for blob hello.
			writeFileT(t, filepath.Join(repo, "f.txt"), "HELLO\n")
			ageCheckout(t, repo)
			reAddT(t, repo, "f.txt")
			if how == "repointed" {
				runGitT(t, repo, "config", "core.attributesFile", plainAttrs)
			} else {
				writeFileT(t, filepath.Join(repo, ".git/info/custom-attrs"), "")
			}
			cloneAndCompare(t, repo, repo, "main")
		})
	}
}

// A config hook's command can span lines, and all of them run, as under
// git.
func TestCloneCheckoutMultiLineConfigHook(t *testing.T) {
	repo := cloneFixture(t)
	runGitT(t, repo, "config", "hook.two.event", "post-checkout")
	runGitT(t, repo, "config", "hook.two.command", "echo one >> \"$PWD.log\"\necho two >> \"$PWD.log\"")
	parent := filepath.Dir(repo)
	runGitT(t, repo, "worktree", "add", "-q", "-b", "p", filepath.Join(parent, "plain"), "main")
	wt := filepath.Join(parent, "clone")
	if err := gitWorktreeAdd(repo, wt, "c", "main", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	plain, clone := readFileT(t, filepath.Join(parent, "plain.log")), readFileT(t, filepath.Join(parent, "clone.log"))
	// git appends the hook's arguments to the last line.
	if !strings.HasPrefix(plain, "one\ntwo ") || clone != plain {
		t.Fatalf("hook wrote %q under git, %q here", plain, clone)
	}
}

// A git without `hook list`: the hooks directory's hook still runs.
func TestCloneCheckoutHookWithoutHookList(t *testing.T) {
	repo := cloneFixture(t)
	log := filepath.Join(t.TempDir(), "log")
	writeFileT(t, filepath.Join(repo, ".git/hooks/post-checkout"), "#!/bin/sh\necho \"ran $3\" >> '"+log+"'\n")
	if err := os.Chmod(filepath.Join(repo, ".git/hooks/post-checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	native := listPostCheckoutHooks
	t.Cleanup(func() { listPostCheckoutHooks = native })
	listPostCheckoutHooks = func(string) (string, error) {
		return "", errors.New("error: unknown subcommand: `list'")
	}
	wt := filepath.Join(filepath.Dir(repo), "clone")
	if err := gitWorktreeAdd(repo, wt, "c", "main", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	if got := readFileT(t, log); got != "ran 1\n" {
		t.Fatalf("log = %q", got)
	}
}

// Neither the clone nor git's checkout filled the worktree: create
// fails and leaves no worktree or branch behind, as git's own failed
// checkout doesn't.
func TestCreateUndoesAnUnfinishedCheckout(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "repo")
	writeFileT(t, filepath.Join(repo, "f.txt"), "f\n")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "c")
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	nativeClone, nativeReset := cloneTree, resetToPlainCheckout
	t.Cleanup(func() { cloneTree, resetToPlainCheckout = nativeClone, nativeReset })
	cloneTree = func(string, string) error { return errors.New("clone broke") }
	resetToPlainCheckout = func(string) error { return errors.New("checkout broke") }
	if _, err := createWorktree(proj, "fresh", "fresh", "main", false, true); err == nil {
		t.Fatal("create succeeded")
	}
	if strings.Contains(gitOut(t, repo, "worktree", "list"), "fresh") {
		t.Fatal("the worktree stayed registered")
	}
	if gitOut(t, repo, "branch", "--list", "fresh") != "" {
		t.Fatal("the branch stayed")
	}
	if _, err := os.Lstat(filepath.Join(root, "worktrees/repo/fresh")); !os.IsNotExist(err) {
		t.Fatalf("the folder stayed: %v", err)
	}
	// And the next create of the same name works.
	cloneTree, resetToPlainCheckout = nativeClone, nativeReset
	if _, err := createWorktree(proj, "fresh", "fresh", "main", false, true); err != nil {
		t.Fatal(err)
	}
}

func TestClonableVolume(t *testing.T) {
	if !clonableVolume(t.TempDir()) {
		t.Fatal("the temp dir's APFS volume reads as unable to clone")
	}
}
