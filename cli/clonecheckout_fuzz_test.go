package main

import (
	"fmt"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Random repos and random states of the source checkout, each cloned
// and checked out plainly from a random commit: the two must match.
// CLONE_FUZZ_N sets how many (default 25), CLONE_FUZZ_SEED the first
// seed, so a failure reruns alone with CLONE_FUZZ_N=1 and its seed.
func TestCloneCheckoutDifferential(t *testing.T) {
	if !treeCloneSupported {
		t.Skip("no clone support on this platform")
	}
	n, first := 25, uint64(1)
	if v, err := strconv.Atoi(os.Getenv("CLONE_FUZZ_N")); err == nil {
		n = v
	}
	if v, err := strconv.ParseUint(os.Getenv("CLONE_FUZZ_SEED"), 10, 64); err == nil {
		first = v
	}
	for seed := first; seed < first+uint64(n); seed++ {
		t.Run(fmt.Sprint(seed), func(t *testing.T) { runCloneScenario(t, seed) })
	}
}

type cloneScenario struct {
	t    *testing.T
	rng  *rand.Rand
	repo string
	log  []string
}

func (s *cloneScenario) logf(format string, args ...any) {
	s.log = append(s.log, fmt.Sprintf(format, args...))
}

func (s *cloneScenario) pick(options ...string) string {
	return options[s.rng.IntN(len(options))]
}

func (s *cloneScenario) git(args ...string) string {
	s.t.Helper()
	out, err := runGit(s.repo, args...)
	if err != nil {
		s.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, strings.Join(s.log, "\n"))
	}
	return out
}

func (s *cloneScenario) gitStdin(env []string, stdin string, args ...string) string {
	s.t.Helper()
	out, err := runGitStdin(s.repo, env, stdin, args...)
	if err != nil {
		s.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, strings.Join(s.log, "\n"))
	}
	return out
}

var (
	fuzzDirs   = []string{"", "", "a/", "A/", "a/b/", "a/B/", "Docs/", "docs/", "deep/x/y/", "sp ace/", "ign/"}
	fuzzNames  = []string{"f", "F", "g.txt", "G.txt", "run.sh", "x.up", "crlf.txt", "bin.dat", "-dash", "uni-é", "l"}
	fuzzBodies = []string{"", "x\n", "y\n", "hello\n", "line\r\nline\r\n", "mixed\r\nlf\n",
		"BIG " + strings.Repeat("z", 5000) + "\n", "\x00\x01binary\n"}
	fuzzAttrs = []string{"*.up filter=upper", "*.txt text", "crlf.txt eol=crlf", "*.sh -text",
		"bin.dat binary", "* text=auto", "g.txt ident", "*.txt eol=lf"}
)

// A tree of random entries, written straight into the object store
// (so it can hold what a case-insensitive disk can't check out), as a
// commit on its own branch.
func (s *cloneScenario) commit(branch string, gitlink string) {
	entries := map[string]string{} // path -> "<mode> <oid>"
	dirs := map[string]bool{}      // to refuse a file where a dir is, and back
	blob := func(content string) string {
		return strings.TrimSpace(s.gitStdin(nil, content, "hash-object", "-w", "--stdin"))
	}
	add := func(p, mode, oid string) {
		for d := path.Dir(p); d != "."; d = path.Dir(d) {
			if entries[d] != "" {
				return
			}
		}
		if dirs[p] {
			return
		}
		entries[p] = mode + " " + oid
		for d := path.Dir(p); d != "."; d = path.Dir(d) {
			dirs[d] = true
		}
	}
	for range 4 + s.rng.IntN(22) {
		p := s.pick(fuzzDirs...) + s.pick(fuzzNames...)
		switch k := s.rng.IntN(20); {
		case k < 12:
			add(p, "100644", blob(s.pick(fuzzBodies...)))
		case k < 15:
			add(p, "100755", blob("#!/bin/sh\necho "+s.pick("a", "b")+"\n"))
		case k < 18:
			add(p, "120000", blob(s.pick("f", "../f", "a", "a/b", "nowhere", "/etc/hosts")))
		case k < 19 && gitlink != "":
			add(p, "160000", gitlink)
		default:
			// A file where an earlier commit may have had a directory.
			add(strings.TrimSuffix(s.pick(fuzzDirs[2:]...), "/"), "100644", blob("was a dir\n"))
		}
	}
	if s.rng.IntN(2) == 0 {
		var lines []string
		for range 1 + s.rng.IntN(3) {
			lines = append(lines, s.pick(fuzzAttrs...))
		}
		add(s.pick("", "a/")+".gitattributes", "100644", blob(strings.Join(lines, "\n")+"\n"))
	}
	add(".gitignore", "100644", blob("*.log\nign/\n"))

	index := filepath.Join(s.t.TempDir(), "index")
	var info strings.Builder
	for p, e := range entries {
		info.WriteString(e + "\t" + p + "\n")
	}
	env := []string{"GIT_INDEX_FILE=" + index}
	s.gitStdin(env, info.String(), "update-index", "--add", "--index-info")
	tree := strings.TrimSpace(s.gitStdin(env, "", "write-tree"))
	c := strings.TrimSpace(s.gitStdin(nil, "", "commit-tree", tree, "-m", branch))
	s.git("branch", "-f", branch, c)
	s.logf("commit %s: %d entries", branch, len(entries))
}

func (s *cloneScenario) trackedPaths() []string {
	var paths []string
	for p := range strings.SplitSeq(s.git("ls-files", "-z"), "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths
}

// One random change to the source checkout, on disk or in its index.
// It never fails the test: it also runs mid-clone, off the test's
// goroutine.
func (s *cloneScenario) mutate(paths []string) {
	if len(paths) == 0 {
		return
	}
	p := s.pick(paths...)
	abs := filepath.Join(s.repo, p)
	// Mutations stay inside the repo: none goes through a symlink the
	// mutations before it made (one to .. would reach the repo itself).
	for d := p; d != "."; d = path.Dir(d) {
		if info, err := os.Lstat(filepath.Join(s.repo, d)); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return
		}
	}
	write := func(rel, content string) {
		full := filepath.Join(s.repo, rel)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		_ = os.RemoveAll(full)
		_ = os.WriteFile(full, []byte(content), 0o644)
	}
	switch k := s.rng.IntN(27); k {
	case 0:
		s.logf("edit %s (same size)", p)
		if b, err := os.ReadFile(abs); err == nil && len(b) > 0 {
			b[0] ^= 1
			_ = os.WriteFile(abs, b, 0o644)
		}
	case 1:
		s.logf("edit %s", p)
		write(p, "edited\n")
	case 2:
		s.logf("delete %s", p)
		_ = os.RemoveAll(abs)
	case 3:
		s.logf("chmod %s 755", p)
		_ = os.Chmod(abs, 0o755)
	case 4:
		s.logf("chmod %s 644", p)
		_ = os.Chmod(abs, 0o644)
	case 5:
		mode := s.pick("444", "600", "664")
		s.logf("chmod %s %s", p, mode)
		m, _ := strconv.ParseUint(mode, 8, 32)
		_ = os.Chmod(abs, os.FileMode(m))
	case 6:
		s.logf("touch %s", p)
		_ = os.Chtimes(abs, time.Now(), time.Now())
	case 7:
		s.logf("replace %s with a dir", p)
		_ = os.RemoveAll(abs)
		write(p+"/inner", "inner\n")
	case 8:
		d := path.Dir(p)
		if d != "." {
			s.logf("replace dir %s with a file", d)
			write(d, "now a file\n")
		}
	case 9:
		f := path.Join(path.Dir(p), s.pick("untracked", "new.txt", "F", ".DS_Store"))
		s.logf("untracked %s", f)
		if _, err := os.Lstat(filepath.Join(s.repo, f)); err != nil {
			write(f, "untracked\n")
		}
	case 10:
		f := s.pick(path.Join(path.Dir(p), "x.log"), "ign/deep/junk")
		s.logf("ignored %s", f)
		if _, err := os.Lstat(filepath.Join(s.repo, f)); err != nil {
			write(f, "ignored\n")
		}
	case 11:
		s.logf("stage an edit to %s", p)
		write(p, "staged\n")
		_, _ = runGit(s.repo, "add", "--", p)
	case 12:
		f := path.Join(path.Dir(p), "ita")
		s.logf("intent-to-add %s", f)
		write(f, "ita\n")
		_, _ = runGit(s.repo, "add", "-N", "--", f)
	case 13:
		s.logf("assume-unchanged %s, then edit", p)
		_, _ = runGit(s.repo, "update-index", "--assume-unchanged", "--", p)
		write(p, "assumed\n")
	case 14:
		s.logf("skip-worktree %s, then delete", p)
		_, _ = runGit(s.repo, "update-index", "--skip-worktree", "--", p)
		_ = os.RemoveAll(abs)
	case 15:
		other := path.Join(path.Dir(p), flipCase(path.Base(p)))
		s.logf("rename %s to %s on disk", p, other)
		tmp := abs + ".tmp-rename"
		if os.Rename(abs, tmp) == nil {
			_ = os.Rename(tmp, filepath.Join(s.repo, other))
		}
	case 16:
		d := path.Join(path.Dir(p), "emptydir")
		s.logf("empty dir %s", d)
		_ = os.MkdirAll(filepath.Join(s.repo, d), 0o755)
	case 17:
		if d := path.Dir(p); d != "." {
			mode := s.pick("700", "750", "775")
			s.logf("chmod dir %s %s", d, mode)
			m, _ := strconv.ParseUint(mode, 8, 32)
			_ = os.Chmod(filepath.Join(s.repo, d), os.FileMode(m))
		}
	case 18:
		s.logf("symlink %s", p)
		_ = os.RemoveAll(abs)
		_ = os.Symlink(s.pick("f", "nowhere", ".."), abs)
	case 19:
		// Has the index vouch for the file as it is now, chmods and
		// all (a refresh can miss a change made the same second).
		s.logf("re-add %s", p)
		_, _ = runGit(s.repo, "rm", "-q", "--cached", "--", p)
		_, _ = runGit(s.repo, "add", "--", p)
	case 20:
		s.logf("chmod %s 000", p)
		_ = os.Chmod(abs, 0)
	case 21:
		if d := path.Dir(p); d != "." {
			s.logf("replace dir %s with a symlink", d)
			_ = os.RemoveAll(filepath.Join(s.repo, d))
			_ = os.Symlink(s.pick("..", "/tmp", "nowhere"), filepath.Join(s.repo, d))
		}
	case 22:
		f := s.pick(".gitattributes", "a/.gitattributes", "Docs/.gitattributes")
		line := s.pick(fuzzAttrs...)
		s.logf("append %q to %s", line, f)
		if fh, err := os.OpenFile(filepath.Join(s.repo, f), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644); err == nil {
			_, _ = fh.WriteString(line + "\n")
			fh.Close()
		}
	case 23:
		f := s.pick(".gitattributes", "a/.gitattributes", ".git/info/attributes")
		s.logf("delete %s", f)
		_ = os.Remove(filepath.Join(s.repo, f))
	case 24:
		line := s.pick(fuzzAttrs...)
		s.logf("info/attributes: %q", line)
		writeInfo(s.repo, line+"\n")
	case 25, 26:
		// The case only a read-back catches: git records a file through
		// a filter, then the attribute goes and the file stays.
		if strings.ContainsAny(p, " \x7f") || !isASCII(p) {
			return
		}
		body, err := os.ReadFile(abs)
		if err != nil {
			return
		}
		where := map[int]string{25: ".git/info/attributes", 26: ".gitattributes"}[k]
		s.logf("record %s through a filter in %s, then drop it", p, where)
		saved, _ := os.ReadFile(filepath.Join(s.repo, where))
		_ = os.WriteFile(abs, []byte(strings.ToUpper(string(body))), 0o644)
		// Old enough that git doesn't take its record for racy.
		_ = os.Chtimes(abs, cloneFixtureTime, cloneFixtureTime)
		_ = os.WriteFile(filepath.Join(s.repo, where), append(append([]byte{}, saved...), []byte("/"+p+" filter=upper\n")...), 0o644)
		_, _ = runGit(s.repo, "rm", "-q", "--cached", "--", p)
		_, _ = runGit(s.repo, "add", "--", p)
		_ = os.WriteFile(filepath.Join(s.repo, where), saved, 0o644)
	}
}

func flipCase(s string) string {
	b := []byte(s)
	for i, c := range b {
		switch {
		case c >= 'a' && c <= 'z':
			b[i] = c - 32
			return string(b)
		case c >= 'A' && c <= 'Z':
			b[i] = c + 32
			return string(b)
		}
	}
	return s + "X"
}

func runCloneScenario(t *testing.T, seed uint64) {
	s := &cloneScenario{t: t, rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
	s.repo = seedRepo(t, t.TempDir(), "repo")
	// Mutations chmod directories, and the temp dir's own cleanup needs
	// to get into them.
	root := filepath.Dir(s.repo)
	t.Cleanup(func() {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if d != nil && d.IsDir() {
				_ = os.Chmod(p, 0o755)
			}
			return nil
		})
	})
	s.git("config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'")
	s.git("config", "filter.upper.smudge", "tr '[:lower:]' '[:upper:]'")
	if s.rng.IntN(8) == 0 {
		v := s.pick("true", "input")
		s.logf("core.autocrlf=%s", v)
		s.git("config", "core.autocrlf", v)
	}
	if s.rng.IntN(8) == 0 {
		s.logf("info/attributes")
		writeFileT(t, filepath.Join(s.repo, ".git/info/attributes"), "*.sh filter=upper\n")
	}
	gitlink := strings.TrimSpace(s.git("rev-parse", "HEAD"))
	branches := []string{"b0", "b1", "b2"}
	for _, b := range branches {
		s.commit(b, gitlink)
	}

	from := s.pick(branches...)
	s.logf("source on %s", from)
	// A plain checkout can fail on what the disk can't hold. Its state
	// is still a state the source can be in.
	_, _ = runGit(s.repo, "checkout", "-q", "-f", from)
	if s.rng.IntN(2) == 0 {
		s.logf("age the files")
		_ = filepath.WalkDir(s.repo, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.Name() == ".git" {
				if err == nil {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink == 0 {
				_ = os.Chtimes(p, cloneFixtureTime, cloneFixtureTime)
			}
			return nil
		})
		_, _ = runGit(s.repo, "update-index", "-q", "--refresh")
	}
	for range s.rng.IntN(9) {
		s.mutate(s.trackedPaths())
	}
	if s.rng.IntN(3) == 0 {
		s.logf("refresh")
		_, _ = runGit(s.repo, "update-index", "-q", "--refresh")
	}

	base := s.pick(branches...)
	s.logf("clone %s", base)
	wt := filepath.Join(filepath.Dir(s.repo), "clone")
	if err := gitWorktreeAdd(s.repo, wt, "clone", base, true); err != nil {
		t.Fatal(err)
	}
	if s.rng.IntN(3) == 0 {
		paths, n := s.trackedPaths(), 1+s.rng.IntN(4)
		s.logf("mid-clone:")
		native := cloneTree
		t.Cleanup(func() { cloneTree = native })
		var once sync.Once
		cloneTree = func(src, dst string) error {
			once.Do(func() {
				for range n {
					s.mutate(paths)
				}
			})
			return native(src, dst)
		}
	}
	if _, err := cloneCheckout(s.repo, wt); err != nil {
		// The one way a clone is meant to give up here: attributes
		// changed under it mid-clone. It then falls back as create does.
		if !strings.Contains(err.Error(), "attributes changed while cloning") {
			t.Fatalf("seed %d: clone failed: %v\n%s", seed, err, strings.Join(s.log, "\n"))
		}
		s.logf("clone gave way: %v", err)
		if err := resetToPlainCheckout(wt); err != nil {
			t.Fatal(err)
		}
	}
	plain := wt + "-plain"
	// A plain checkout of a tree the disk can't hold errors out after
	// writing what it can. The clone must land the same.
	_, _ = runGit(s.repo, "worktree", "add", "-q", "-b", "plain", "--", plain, base)
	diffs := compareCheckouts(t, wt, plain)
	// Again, now that the first clone has recorded what it proved.
	if len(diffs) == 0 && s.rng.IntN(3) == 0 {
		s.logf("clone %s again", base)
		again := wt + "-again"
		if err := gitWorktreeAdd(s.repo, again, "again", base, true); err != nil {
			t.Fatal(err)
		}
		if _, err := cloneCheckout(s.repo, again); err != nil {
			t.Fatalf("seed %d: second clone failed: %v\n%s", seed, err, strings.Join(s.log, "\n"))
		}
		diffs = compareCheckouts(t, again, plain)
	}
	if len(diffs) > 0 {
		tree, _ := runGit(s.repo, "ls-tree", "-r", base)
		t.Fatalf("seed %d differs:\n%s\n--- scenario\n%s\n--- %s\n%s",
			seed, strings.Join(diffs, "\n"), strings.Join(s.log, "\n"), base, tree)
	}
}

func clip(s string) string {
	if len(s) > 60 {
		return s[:60] + "…"
	}
	return s
}

func writeInfo(repo, content string) {
	p := filepath.Join(repo, ".git/info/attributes")
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, []byte(content), 0o644)
}

// Every way a clone can differ from the plain checkout beside it.
func compareCheckouts(t *testing.T, wt, plain string) []string {
	var diffs []string
	want, got := worktreeContents(t, plain), worktreeContents(t, wt)
	for _, p := range slices.Sorted(func(yield func(string) bool) {
		for p := range want {
			if !yield(p) {
				return
			}
		}
		for p := range got {
			if _, ok := want[p]; !ok && !yield(p) {
				return
			}
		}
	}) {
		if want[p] != got[p] {
			diffs = append(diffs, fmt.Sprintf("%s: clone %q, plain %q", p, clip(got[p]), clip(want[p])))
		}
	}
	if w, g := gitOut(t, plain, "ls-files", "-s"), gitOut(t, wt, "ls-files", "-s"); w != g {
		diffs = append(diffs, fmt.Sprintf("git ls-files -s:\nclone %q\nplain %q", g, w))
	}
	// A committed blob that its own attributes wouldn't produce (CRLF
	// endings under a text attribute, content a filter's clean side
	// changes) reads as modified only when git looks at its bytes, which
	// it does for a file written within the second its index was (most
	// of a fresh checkout) and not otherwise. So that one status line is
	// down to timing, on either side. The bytes are held equal above.
	unnormalized := func(p string) bool {
		oid, err := runGit(plain, "rev-parse", "HEAD:"+p)
		cleaned, err2 := runGit(plain, "hash-object", "--path", p, "--", filepath.Join(plain, p))
		return err == nil && err2 == nil && strings.TrimSpace(oid) != strings.TrimSpace(cleaned)
	}
	// What git status says, or how it fails: plain git can refuse a
	// tree too (a submodule path that resolves through a symlink), and
	// the clone has to refuse it the same way.
	status := func(dir string) string {
		out, err := runGit(dir, "status", "--porcelain", "-z", "--untracked-files=all", "--ignored")
		var kept []string
		for rec := range strings.SplitSeq(out, "\x00") {
			if len(rec) > 3 && rec[:3] == " M " && unnormalized(rec[3:]) {
				continue
			}
			kept = append(kept, rec)
		}
		if err != nil {
			kept = append(kept, "error: "+strings.ReplaceAll(err.Error(), dir, "WORKTREE"))
		}
		return strings.Join(kept, "\n")
	}
	if w, g := status(plain), status(wt); w != g {
		diffs = append(diffs, fmt.Sprintf("git status:\nclone %q\nplain %q", g, w))
	}
	return diffs
}
