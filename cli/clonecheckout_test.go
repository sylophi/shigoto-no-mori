package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var cloneFixtureTime = time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)

// A primary checkout with everything a clone checkout has to tell
// apart: plain, executable and symlinked files, a submodule, a branch
// that differs from the primary's, and on disk an ignored dir, an
// untracked file, a dirty file, a touched-but-unchanged one and two
// deleted ones. Plus
// files git calls clean whose bytes aren't what a checkout writes: a
// filtered one, and line endings a checkout would change.
func cloneFixture(t *testing.T) string {
	t.Helper()
	repo := seedRepo(t, t.TempDir(), "repo")
	runGitT(t, repo, "config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'")
	runGitT(t, repo, "config", "filter.upper.smudge", "tr '[:lower:]' '[:upper:]'")
	for p, content := range map[string]string{
		".gitattributes":  "*.up filter=upper\n*.crlf eol=crlf\n*.txt text\n",
		"shout.up":        "hello\n",
		"dos.crlf":        "lf on disk\n",
		"win.txt":         "crlf\r\non disk\r\n",
		".gitignore":      "node_modules/\n*.log\n",
		"README.md":       "readme\n",
		"src/a.go":        "package a\n",
		"src/deep/b.go":   "package deep\n",
		"src/deep/c.txt":  "c\n",
		"pure/one.txt":    "one\n",
		"pure/sub/two.md": "two\n",
		"docs/x.md":       "x\n",
		"docs/y.md":       "y\n",
		"bin/run.sh":      "#!/bin/sh\n",
		"vanished.md":     "deleted on disk\n",
		"gone/away.txt":   "deleted on disk\n",
	} {
		writeFileT(t, filepath.Join(repo, p), content)
	}
	if err := os.Chmod(filepath.Join(repo, "bin/run.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	for link, target := range map[string]string{"link": "src/a.go", "dirlink": "src"} {
		if err := os.Symlink(target, filepath.Join(repo, link)); err != nil {
			t.Fatal(err)
		}
	}
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "files")
	head := strings.TrimSpace(gitOut(t, repo, "rev-parse", "HEAD"))
	runGitT(t, repo, "update-index", "--add", "--cacheinfo", "160000,"+head+",vendor/sub")
	runGitT(t, repo, "commit", "-q", "-m", "submodule")

	runGitT(t, repo, "checkout", "-q", "-b", "other")
	writeFileT(t, filepath.Join(repo, "docs/y.md"), "y on other\n")
	writeFileT(t, filepath.Join(repo, "docs/z.md"), "z\n")
	runGitT(t, repo, "rm", "-q", "src/deep/c.txt")
	runGitT(t, repo, "add", ".")
	runGitT(t, repo, "commit", "-q", "-m", "other")
	runGitT(t, repo, "checkout", "-q", "main")

	// Old mtimes, as a checkout that has sat for a while has, so a
	// clone (which keeps them) is told apart from a git write (now).
	err := filepath.WalkDir(repo, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		return os.Chtimes(p, cloneFixtureTime, cloneFixtureTime)
	})
	if err != nil {
		t.Fatal(err)
	}
	runGitT(t, repo, "update-index", "-q", "--refresh")

	writeFileT(t, filepath.Join(repo, "node_modules/pkg/index.js"), "ignored\n")
	writeFileT(t, filepath.Join(repo, "app.log"), "ignored\n")
	writeFileT(t, filepath.Join(repo, "src/new.txt"), "untracked\n")
	writeFileT(t, filepath.Join(repo, "src/deep/b.go"), "package deep // dirty\n")
	writeFileT(t, filepath.Join(repo, "docs/x.md"), "x\n")
	for _, p := range []string{"vanished.md", "gone/away.txt"} {
		if err := os.Remove(filepath.Join(repo, p)); err != nil {
			t.Fatal(err)
		}
	}
	return repo
}

// Everything on disk in a worktree but its .git link: kind, exec bit,
// and content or link target, per path.
func worktreeContents(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		switch {
		case rel == ".":
			return nil
		case rel == ".git":
			return nil
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			files[rel] = "link " + target
			return err
		case d.IsDir():
			info, err := d.Info()
			if err == nil {
				files[rel+"/"] = "dir " + info.Mode().Perm().String()
			}
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		content, err := os.ReadFile(p)
		files[rel] = info.Mode().Perm().String() + " " + string(content)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// A clone checkout must leave exactly what `git worktree add` does: the
// same files, index entries and status.
func assertSameAsPlainCheckout(t *testing.T, repo, cloned, base string) {
	t.Helper()
	plain := cloned + "-plain"
	if err := gitWorktreeAdd(repo, plain, "plain-"+filepath.Base(filepath.Dir(cloned))+"-"+filepath.Base(cloned), base, false); err != nil {
		t.Fatal(err)
	}
	want, got := worktreeContents(t, plain), worktreeContents(t, cloned)
	for p, w := range want {
		if got[p] != w {
			t.Errorf("%s: got %q, want %q", p, got[p], w)
		}
	}
	for p, g := range got {
		if _, ok := want[p]; !ok {
			t.Errorf("%s: unexpected %q", p, g)
		}
	}
	for _, args := range [][]string{
		{"ls-files", "-s"},
		{"status", "--porcelain", "--untracked-files=all", "--ignored"},
	} {
		if w, g := gitOut(t, plain, args...), gitOut(t, cloned, args...); w != g {
			t.Errorf("git %s:\ngot  %q\nwant %q", strings.Join(args, " "), g, w)
		}
	}
}

func TestCloneCheckoutMatchesPlainCheckout(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	for _, base := range []string{"main", "other"} {
		t.Run(base, func(t *testing.T) {
			wt := filepath.Join(filepath.Dir(repo), "clone-"+base)
			if err := gitWorktreeAdd(repo, wt, "clone-"+base, base, true); err != nil {
				t.Fatal(err)
			}
			report, err := cloneCheckout(repo, wt)
			if err != nil {
				t.Fatal(err)
			}
			if report.Cloned == 0 {
				t.Fatalf("nothing cloned: %+v", report)
			}
			// Git trusts the stat written for the clones: a status finds
			// nothing to refresh, so the index stays byte-identical.
			before := gitOut(t, wt, "ls-files", "-s", "--debug")
			gitOut(t, wt, "status", "--porcelain")
			if after := gitOut(t, wt, "ls-files", "-s", "--debug"); after != before {
				t.Fatalf("status refreshed the index:\nbefore %s\nafter %s", before, after)
			}
			assertSameAsPlainCheckout(t, repo, wt, base)

			// Cloned, not written: the primary's old mtime survived.
			info, err := os.Lstat(filepath.Join(wt, "pure/sub/two.md"))
			if err != nil || !info.ModTime().Equal(cloneFixtureTime) {
				t.Fatalf("pure/sub/two.md wasn't cloned (%v, %v)", info, err)
			}
			// The dirty file came from git, with the commit's bytes.
			if got := readFileT(t, filepath.Join(wt, "src/deep/b.go")); got != "package deep\n" {
				t.Fatalf("src/deep/b.go = %q", got)
			}

		})
	}
}

// The source changing under the clone: a file edited in place goes to
// git, and a file appearing in a folder cloned whole (the attributes
// read again, unchanged) doesn't come along.
func TestCloneCheckoutSurvivesSourceEditsMidClone(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	repo := cloneFixture(t)
	native := cloneTree
	t.Cleanup(func() { cloneTree = native })
	var once sync.Once
	cloneTree = func(src, dst string) error {
		once.Do(func() {
			writeFileT(t, filepath.Join(repo, "docs/y.md"), "edited mid-clone\n")
			writeFileT(t, filepath.Join(repo, "pure/sub/sneaky.txt"), "new\n")
		})
		return native(src, dst)
	}
	wt := filepath.Join(filepath.Dir(repo), "clone")
	if err := gitWorktreeAdd(repo, wt, "clone", "main", true); err != nil {
		t.Fatal(err)
	}
	if report, err := cloneCheckout(repo, wt); err != nil || report.Cloned == 0 {
		t.Fatalf("report = %+v, %v", report, err)
	}
	if got := readFileT(t, filepath.Join(wt, "docs/y.md")); got != "y\n" {
		t.Fatalf("docs/y.md = %q", got)
	}
	if _, err := os.Lstat(filepath.Join(wt, "pure/sub/sneaky.txt")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("untracked file came along: %v", err)
	}
	if status := gitOut(t, wt, "status", "--porcelain", "--untracked-files=all"); status != "" {
		t.Fatalf("status = %q", status)
	}
}

func TestOrdinaryIndexFlags(t *testing.T) {
	for flags, want := range map[string]bool{
		"0": true, "200000": true, "100000": true, // fsmonitor, name hash
		"1000": false, "2000": false, "3000": false, // stages
		"8000": false, "20000000": false, "40000000": false, // assume-unchanged, intent-to-add, skip-worktree
		"zz": false,
	} {
		if got := ordinaryIndexFlags(flags); got != want {
			t.Errorf("ordinaryIndexFlags(%q) = %v", flags, got)
		}
	}
}

// A clone that fails partway leaves the plain checkout behind, and the
// post-checkout hook runs once either way, as `git worktree add` runs it.
func TestCloneCheckoutFallsBackToGit(t *testing.T) {
	repo := cloneFixture(t)
	hookLog := filepath.Join(t.TempDir(), "hook.log")
	writeFileT(t, filepath.Join(repo, ".git/hooks/post-checkout"),
		"#!/bin/sh\necho \"$@\" >> '"+hookLog+"'\n")
	if err := os.Chmod(filepath.Join(repo, ".git/hooks/post-checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	native := cloneTree
	t.Cleanup(func() { cloneTree = native })
	cloneTree = func(_, dst string) error {
		writeFileT(t, filepath.Join(dst, "partial"), "")
		return errors.ErrUnsupported
	}
	wt := filepath.Join(filepath.Dir(repo), "clone")
	if err := gitWorktreeAdd(repo, wt, "clone", "other", true); err != nil {
		t.Fatal(err)
	}
	if err := finishCloneCheckout(worktreeIdentity{Name: "repo", Path: repo, IsPrimary: true}, wt); err != nil {
		t.Fatal(err)
	}
	head := strings.TrimSpace(gitOut(t, wt, "rev-parse", "HEAD"))
	if got, want := readFileT(t, hookLog), strings.Repeat("0", len(head))+" "+head+" 1\n"; got != want {
		t.Fatalf("hook ran with %q, want %q", got, want)
	}
	if err := os.Remove(hookLog); err != nil {
		t.Fatal(err)
	}
	assertSameAsPlainCheckout(t, repo, wt, "other")
}

func TestParseLsFilesDebug(t *testing.T) {
	out := "100644 78981922613b2afb6025042ff6bd878ac1994e85 0\ta b\x00" +
		"  ctime: 1:2\n  mtime: 3:4\n  dev: 5\tino: 6\n  uid: 7\tgid: 8\n  size: 9\tflags: 0\n" +
		"120000 2e65efe2a145dda7ee51d1741299f848e5bf752e 2\tline\nbreak\x00" +
		"  ctime: 0:0\n  mtime: 0:0\n  dev: 0\tino: 0\n  uid: 0\tgid: 0\n  size: 0\tflags: 2000\n"
	entries, err := parseLsFilesDebug(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	first := entries[0]
	if first.path != "a b" || first.mode != 0o100644 || first.stage != 0 || first.flags != "0" ||
		first.stat != (indexStat{ctimeSec: 1, ctimeNsec: 2, mtimeSec: 3, mtimeNsec: 4, dev: 5, ino: 6, uid: 7, gid: 8, size: 9}) {
		t.Fatalf("first = %+v", first)
	}
	if second := entries[1]; second.path != "line\nbreak" || second.mode != 0o120000 || second.stage != 2 || second.flags != "2000" {
		t.Fatalf("second = %+v", second)
	}
}
