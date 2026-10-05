package main

// Clone checkout: a new worktree's tracked files cloned out of an
// existing checkout (cloneTree, APFS clonefile) instead of written by
// git. A clone shares the source's blocks, so a whole directory lands
// in one call however many files it holds, and git's index for the new
// worktree is written here with each clone's own stat data, so git
// trusts the files without reading them back. Letting git build that
// index instead would hash every clone (new inode, new ctime), which is
// slower than the plain checkout this replaces.
//
// A file is only cloned when the source's index vouches for its bytes:
// the same blob and mode as the new worktree's commit, an ordinary
// entry (no conflict, skip-worktree, assume-unchanged, intent-to-add),
// not racily clean, no attribute or config on either side that would
// make a checkout write anything but the blob, and, checked once it is
// cloned, a file on disk whose stat still matches what git recorded
// when it last hashed it (to the nanosecond, so an edit before or
// during the clone shows), with nothing on it a checkout wouldn't give
// it (other permissions, file flags, extended attributes). Everything
// else (paths the source lacks or has dirty, paths that collide on a
// case-insensitive disk, submodules) is left to `git checkout-index`,
// which writes them as a checkout would.
//
// Any failure resets the worktree to a plain checkout, so the worst a
// clone checkout does is cost the time it took.

import (
	"bytes"
	"cmp"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"iter"
	"maps"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type cloneCheckoutReport struct {
	Cloned  int // tracked files cloned
	Written int // tracked paths git wrote, submodules included
	Hashed  int // clones read back and hashed against their blob
}

// git's index stat data, each field truncated to the 32 bits the index
// stores, as git does.
type indexStat struct {
	ctimeSec, ctimeNsec, mtimeSec, mtimeNsec uint32
	dev, ino, mode, uid, gid, size           uint32
}

func indexStatOf(st *unix.Stat_t) indexStat {
	return indexStat{
		ctimeSec: uint32(st.Ctim.Sec), ctimeNsec: uint32(st.Ctim.Nsec),
		mtimeSec: uint32(st.Mtim.Sec), mtimeNsec: uint32(st.Mtim.Nsec),
		dev: uint32(st.Dev), ino: uint32(st.Ino), mode: uint32(st.Mode),
		uid: st.Uid, gid: st.Gid, size: uint32(st.Size),
	}
}

func lstatIndex(p string) (indexStat, error) {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return indexStat{}, err
	}
	return indexStatOf(&st), nil
}

// The fields git compares to decide a file is unchanged (core.checkStat
// default), minus mode, which matchesMode covers.
func (s indexStat) sameFile(o indexStat) bool {
	return s.ctimeSec == o.ctimeSec && s.ctimeNsec == o.ctimeNsec &&
		s.mtimeSec == o.mtimeSec && s.mtimeNsec == o.mtimeNsec &&
		s.dev == o.dev && s.ino == o.ino &&
		s.uid == o.uid && s.gid == o.gid && s.size == o.size
}

// Whether a file of this stat is what an index entry of this mode
// describes: a symlink for 120000, a regular file with the matching
// owner exec bit otherwise.
func (s indexStat) matchesMode(mode uint32) bool {
	switch mode {
	case 0o120000:
		return s.mode&unix.S_IFMT == unix.S_IFLNK
	case 0o100755:
		return s.mode&unix.S_IFMT == unix.S_IFREG && s.mode&0o100 != 0
	case 0o100644:
		return s.mode&unix.S_IFMT == unix.S_IFREG && s.mode&0o100 == 0
	}
	return false
}

type treeEntry struct {
	mode uint32
	oid  string
	path string
}

type sourceEntry struct {
	treeEntry
	stage int
	flags string
	stat  indexStat
}

// `git ls-tree -r -z`: "<mode> <type> <oid>\t<path>" records.
func parseLsTree(out string) ([]treeEntry, error) {
	var entries []treeEntry
	for rec := range strings.SplitSeq(out, "\x00") {
		if rec == "" {
			continue
		}
		meta, p, ok := strings.Cut(rec, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 {
			return nil, fmt.Errorf("unexpected ls-tree record %q", rec)
		}
		mode, err := strconv.ParseUint(fields[0], 8, 32)
		if err != nil {
			return nil, err
		}
		entries = append(entries, treeEntry{uint32(mode), fields[2], p})
	}
	return entries, nil
}

// `git ls-files -s -z --debug`: each "<mode> <oid> <stage>\t<path>\0"
// header is followed by five newline-terminated stat lines.
func parseLsFilesDebug(out string) ([]sourceEntry, error) {
	var entries []sourceEntry
	rest := out
	for rest != "" {
		header, after, ok := strings.Cut(rest, "\x00")
		if !ok {
			return nil, fmt.Errorf("unterminated ls-files record %q", rest)
		}
		meta, p, ok := strings.Cut(header, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 {
			return nil, fmt.Errorf("unexpected ls-files record %q", header)
		}
		mode, err := strconv.ParseUint(fields[0], 8, 32)
		if err != nil {
			return nil, err
		}
		stage, err := strconv.Atoi(fields[2])
		if err != nil {
			return nil, err
		}
		e := sourceEntry{treeEntry: treeEntry{uint32(mode), fields[1], p}, stage: stage}
		values := map[string]string{}
		for range 5 {
			line, next, ok := strings.Cut(after, "\n")
			if !ok {
				return nil, fmt.Errorf("short stat block for %q", p)
			}
			after = next
			for field := range strings.SplitSeq(strings.TrimSpace(line), "\t") {
				k, v, _ := strings.Cut(field, ": ")
				values[k] = v
			}
		}
		u32 := func(s string) uint32 {
			n, perr := strconv.ParseUint(s, 10, 32)
			if perr != nil && err == nil {
				err = fmt.Errorf("bad stat value %q for %q", s, p)
			}
			return uint32(n)
		}
		pair := func(s string) (uint32, uint32) {
			a, b, _ := strings.Cut(s, ":")
			return u32(a), u32(b)
		}
		e.stat.ctimeSec, e.stat.ctimeNsec = pair(values["ctime"])
		e.stat.mtimeSec, e.stat.mtimeNsec = pair(values["mtime"])
		e.stat.dev, e.stat.ino = u32(values["dev"]), u32(values["ino"])
		e.stat.uid, e.stat.gid = u32(values["uid"]), u32(values["gid"])
		e.stat.size = u32(values["size"])
		e.flags = values["flags"]
		if err != nil {
			return nil, err
		}
		entries = append(entries, e)
		rest = after
	}
	return entries, nil
}

// ls-files --debug prints the entry's in-memory flags in hex. A
// conflict stage, assume-unchanged, intent-to-add or skip-worktree
// means the entry isn't a plain record of a file on disk. The other
// in-memory bits (fsmonitor's mark, name hashing) say nothing about
// the file. A backstop: the stat check after cloning already turns
// down every such file whose bytes could be off.
func ordinaryIndexFlags(flags string) bool {
	const (
		stage         = 0x3000
		assumeValid   = 0x8000
		intentToAdd   = 1 << 29
		skipWorktree  = 1 << 30
		notAPlainFile = stage | assumeValid | intentToAdd | skipWorktree
	)
	n, err := strconv.ParseUint(flags, 16, 32)
	return err == nil && n&notAPlainFile == 0
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// The attributes that can make a checkout write anything but the
// blob's bytes.
var conversionAttrs = []string{"filter", "ident", "working-tree-encoding", "text", "eol", "crlf"}

// The config a checkout's conversions read.
type checkoutConfig struct {
	autocrlf string // "true", "input" or "false"
	eol      string // "crlf", "lf" or "native"
	symlinks bool
}

// What decides each path's conversions: the attributes as a checkout of
// HEAD sees them (its .gitattributes, as the new worktree has none on
// disk yet, info/attributes, the user's own) and as the source saw them
// when it wrote and last hashed its files (a conversion there, a filter
// another commit drops, means its bytes aren't the blob's), and both
// sides' config.
type conversions struct {
	attr, srcAttr     string
	config, srcConfig checkoutConfig
}

func readConversions(source, worktreePath, paths string) (conversions, error) {
	var c conversions
	var errs [2]error
	var wg sync.WaitGroup
	wg.Go(func() {
		c.attr, errs[0] = runGitStdin(worktreePath, nil, paths,
			append([]string{"check-attr", "--source", "HEAD", "-z", "--stdin"}, conversionAttrs...)...)
	})
	wg.Go(func() {
		c.srcAttr, errs[1] = runGitStdin(source, nil, paths,
			append([]string{"check-attr", "-z", "--stdin"}, conversionAttrs...)...)
	})
	wg.Go(func() { c.config = readCheckoutConfig(worktreePath) })
	wg.Go(func() { c.srcConfig = readCheckoutConfig(source) })
	wg.Wait()
	return c, errors.Join(errs[:]...)
}

func readCheckoutConfig(checkout string) checkoutConfig {
	get := func(args ...string) (string, bool) {
		// Unset reads as an exit code 1 with no output.
		out, err := runGit(checkout, append([]string{"config"}, args...)...)
		return strings.ToLower(strings.TrimSpace(out)), err == nil
	}
	c := checkoutConfig{autocrlf: "false", symlinks: true}
	c.eol, _ = get("--get", "core.eol")
	// git reads booleans its own way (a bare key, "1k" and "" all
	// count), so it's asked to. autocrlf also takes "input", which isn't
	// a boolean. A value git can't read at all is taken as true, which
	// only leaves more to git.
	if raw, set := get("--get", "core.autocrlf"); raw == "input" {
		c.autocrlf = "input"
	} else if set {
		if v, ok := get("--type=bool", "--get", "core.autocrlf"); !ok || v == "true" {
			c.autocrlf = "true"
		}
	}
	if _, set := get("--get", "core.symlinks"); set {
		v, ok := get("--type=bool", "--get", "core.symlinks")
		c.symlinks = ok && v == "true"
	}
	return c
}

// Paths whose checkout runs through something other than git copying
// the blob out: a filter (LFS), ident, a working-tree encoding, or line
// endings turned to CRLF (eol=crlf, or text with core.autocrlf=true or
// core.eol=crlf). Their bytes on disk in a clean checkout needn't be
// what a checkout writes. From check-attr -z: path, attr, value
// triples.
func checkoutConverts(attrOut string, config checkoutConfig) map[string]bool {
	fields := strings.Split(attrOut, "\x00")
	converted := map[string]bool{}
	crlfByDefault := config.autocrlf == "true" || config.eol == "crlf"
	for i := 0; i+2 < len(fields); i += 3 {
		p, attr, value := fields[i], fields[i+1], fields[i+2]
		specified := value != "unspecified" && value != "unset"
		switch attr {
		case "filter", "ident", "working-tree-encoding":
			if specified {
				converted[p] = true
			}
		case "crlf":
			// Set, unset (-crlf, binary) or "input": any says text or not.
			if value != "unspecified" {
				converted[p] = true
			}
		case "eol":
			if value == "crlf" {
				converted[p] = true
			}
		case "text":
			if crlfByDefault && value != "unset" {
				converted[p] = true
			}
		}
	}
	return converted
}

// The index file's mtime, which decides raciness: an entry whose mtime
// isn't strictly older than its index could have changed in the same
// tick git hashed it, so its stat proves nothing. A backstop on APFS,
// whose nanosecond ctime (compared exactly after cloning) moves on any
// write. It matters where timestamps are coarser.
func indexMtime(index string) (sec, nsec uint32, err error) {
	st, err := lstatIndex(index)
	return st.mtimeSec, st.mtimeNsec, err
}

// Where `name` is under the checkout's git dir (`rev-parse
// --git-path`), as an absolute path.
func gitPath(checkout, name string) (string, error) {
	out, err := runGit(checkout, "rev-parse", "--path-format=absolute", "--git-path", name)
	return strings.TrimSpace(out), err
}

// p's folders, nearest first, up to (not including) the tree's root.
func ancestors(p string) iter.Seq[string] {
	return func(yield func(string) bool) {
		for d := path.Dir(strings.TrimSuffix(p, "/")); d != "."; d = path.Dir(d) {
			if !yield(d) {
				return
			}
		}
	}
}

func olderThan(sec, nsec, thanSec, thanNsec uint32) bool {
	return sec < thanSec || (sec == thanSec && nsec < thanNsec)
}

// Runs fn over items on a small worker pool, returning the first error.
func forEachParallel[T any](items []T, fn func(T) error) error {
	ch := make(chan T)
	var wg sync.WaitGroup
	var once sync.Once
	var first error
	for range min(len(items), runtime.NumCPU()*2) {
		wg.Go(func() {
			for item := range ch {
				if err := fn(item); err != nil {
					once.Do(func() { first = err })
				}
			}
		})
	}
	for _, item := range items {
		ch <- item
	}
	close(ch)
	wg.Wait()
	return first
}

// The checkout a new worktree's files are cloned from: the checkout on
// the base branch, else the primary, else any other, the order
// carry-over looks in (only their files' stat decides what is cloned,
// so any will do). Nil when none can be.
func pickCloneSource(proj project, existing []worktreeIdentity, worktreePath, base string, remotes []string) *worktreeIdentity {
	if blocker := projectCloneBlocker(proj.Path); blocker != "" {
		vlog("[clone checkout] none: %s", blocker)
		return nil
	}
	baseBranch := ""
	if base != "" {
		baseBranch, _ = resolveCheckoutRef(proj.Path, base, remotes)
	}
	for _, id := range orderCarryOverSources(existing, worktreePath, baseBranch) {
		if blocker := sourceCloneBlocker(id.Path, worktreePath); blocker != "" {
			vlog("[clone checkout] not from %s: %s", id.Path, blocker)
			continue
		}
		return &id
	}
	return nil
}

// Why no checkout of the project can be cloned from, or "" when one
// can.
func projectCloneBlocker(projectPath string) string {
	if !treeCloneSupported {
		return "no clone support on this platform"
	}
	// A sparse checkout's new worktree is sparse too, which only git
	// knows how to lay out. A split index keeps entries in a shared file
	// whose raciness cutoff isn't the index's own.
	if blocker := sparseOrSplit(projectPath); blocker != "" {
		return blocker
	}
	// Replacement objects change what a blob reads as, so the source's
	// files needn't hold what a checkout writes now.
	if os.Getenv("GIT_NO_REPLACE_OBJECTS") == "" {
		useReplace, _ := runGit(projectPath, "config", "--bool", "core.useReplaceRefs")
		refs, _ := runGit(projectPath, "for-each-ref", "--count=1", "--format=x",
			cmp.Or(os.Getenv("GIT_REPLACE_REF_BASE"), "refs/replace/"))
		if strings.TrimSpace(useReplace) != "false" && strings.TrimSpace(refs) != "" {
			return "replace refs"
		}
	}
	return ""
}

// Why this checkout can't be cloned from, or "" when it can.
func sourceCloneBlocker(source, worktreePath string) string {
	var src, dst unix.Stat_t
	if unix.Stat(source, &src) != nil || unix.Stat(filepath.Dir(worktreePath), &dst) != nil {
		return "source missing"
	}
	if src.Dev != dst.Dev {
		return "different volume"
	}
	if !clonableVolume(source) {
		return "volume can't clone"
	}
	return sparseOrSplit(source)
}

func sparseOrSplit(checkout string) string {
	if out, _ := runGit(checkout, "config", "--bool", "core.sparseCheckout"); strings.TrimSpace(out) == "true" {
		return "sparse checkout"
	}
	if out, _ := runGit(checkout, "config", "--bool", "core.splitIndex"); strings.TrimSpace(out) == "true" {
		return "split index"
	}
	return ""
}

// The checkout half of `git worktree add` for one made --no-checkout:
// a clone checkout, or git's own when that fails, then the
// post-checkout hook git skipped. Only a failed fallback is an error.
func finishCloneCheckout(source worktreeIdentity, worktreePath string) error {
	report, err := cloneCheckout(source.Path, worktreePath)
	if err != nil {
		note(dimErr("[checkout]") + fmt.Sprintf(" cloning failed (%v), checking out with git", err))
		if err := resetToPlainCheckout(worktreePath); err != nil {
			return checkoutUnfinished{err}
		}
	} else if !jsonMode {
		from := source.Name
		if source.IsPrimary {
			from = "the primary checkout"
		}
		hashed := ""
		if report.Hashed > 0 {
			// Files git last checked before the attributes changed.
			hashed = fmt.Sprintf(" (%d read back to verify)", report.Hashed)
		}
		note(dimErr("[checkout]") + fmt.Sprintf(" %d files cloned from %s%s, %d written by git",
			report.Cloned, from, hashed, report.Written))
	}
	head, err := runGit(worktreePath, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	return runPostCheckoutHook(worktreePath, strings.TrimSpace(head))
}

// Runs post-checkout as `git worktree add` does after its checkout:
// every hook `git hook list` names, in its order (config hooks, then
// the hooks directory's), in the new worktree, with GIT_DIR and
// GIT_WORK_TREE unset. `git hook run` would export GIT_DIR, which turns
// a hook's git commands in other repositories on this one.
func runPostCheckoutHook(worktreePath, head string) error {
	args := []string{strings.Repeat("0", len(head)), head, "1"}
	hooksDir, err := gitPath(worktreePath, "hooks")
	if err != nil {
		return err
	}
	list, err := listPostCheckoutHooks(worktreePath)
	if err != nil {
		if strings.Contains(err.Error(), "no hooks found") {
			return nil
		}
		// A git without `hook list` (before 2.54) has no config hooks
		// either, only the hooks directory's, which runs when it's
		// executable.
		list = ""
		if info, err := os.Stat(filepath.Join(hooksDir, "post-checkout")); err == nil && info.Mode()&0o111 != 0 {
			list = "hook from hookdir"
		}
	}
	execPath, err := runGit(worktreePath, "--exec-path")
	if err != nil {
		return err
	}
	dir, err := filepath.EvalSymlinks(worktreePath)
	if err != nil {
		return err
	}
	// The environment git gives its hooks: its exec path exported and
	// first on PATH, no prefix.
	execPath = strings.TrimSpace(execPath)
	env := []string{"GIT_EXEC_PATH=" + execPath, "GIT_PREFIX=", "PATH=" + execPath + ":" + os.Getenv("PATH")}
	for _, kv := range envWithoutCdFile() {
		switch key, _, _ := strings.Cut(kv, "="); key {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_EXEC_PATH", "GIT_PREFIX", "PATH":
		default:
			env = append(env, kv)
		}
	}
	command := func(name string, args ...string) ([]byte, error) {
		cmd := exec.Command(name, args...)
		cmd.Dir = dir
		cmd.Env = env
		return cmd.CombinedOutput()
	}
	run := func(name string, args ...string) error {
		out, err := command(name, args...)
		// A script without a #! line, which git hands to sh as a shell
		// would.
		if errors.Is(err, unix.ENOEXEC) {
			out, err = command("/bin/sh", append([]string{name}, args...)...)
		}
		if err != nil {
			return fmt.Errorf("post-checkout hook: %s", cmp.Or(strings.TrimSpace(string(out)), err.Error()))
		}
		return nil
	}
	// Like git, every hook runs even after one fails, and the first
	// failure is the result.
	var first error
	for name := range strings.SplitSeq(strings.TrimRight(list, "\x00"), "\x00") {
		if name == "" {
			continue
		}
		if name == "hook from hookdir" {
			err = run(filepath.Join(hooksDir, "post-checkout"), args...)
		} else {
			// A config hook's command goes through the shell with the
			// hook's arguments after it, as git runs it.
			// The last value wins, as for git. NUL-separated: a command
			// can span lines.
			var commands string
			if commands, err = runGit(worktreePath, "config", "-z", "--get-all", "hook."+name+".command"); err == nil {
				values := strings.Split(strings.TrimSuffix(commands, "\x00"), "\x00")
				command := values[len(values)-1]
				err = run("/bin/sh", append([]string{"-c", command + ` "$@"`, command}, args...)...)
			}
		}
		if first == nil {
			first = err
		}
	}
	return first
}

// A worktree added --no-checkout that neither the clone nor git's own
// checkout filled. The caller undoes the add, as git does when its own
// checkout fails.
type checkoutUnfinished struct{ err error }

func (e checkoutUnfinished) Error() string { return e.err.Error() }
func (e checkoutUnfinished) Unwrap() error { return e.err }

// `git hook list -z post-checkout`, a var so tests can stand in for a
// git without it.
var listPostCheckoutHooks = func(worktreePath string) (string, error) {
	return runGit(worktreePath, "hook", "list", "-z", "post-checkout")
}

// Empties the worktree (but its .git link) and checks HEAD out with
// git, the state a plain `git worktree add` leaves. A var so tests can
// fail it.
var resetToPlainCheckout = func(worktreePath string) error {
	entries, err := os.ReadDir(worktreePath)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() != ".git" {
			if err := forceRemoveAll(filepath.Join(worktreePath, e.Name())); err != nil {
				return err
			}
		}
	}
	_, err = runGit(worktreePath, "read-tree", "--reset", "-u", "HEAD")
	return err
}

// Fills a worktree made with `git worktree add --no-checkout` with its
// HEAD's tracked files, cloned from `source` where safe and written by
// git elsewhere, and its index. On error the caller resets it.
func cloneCheckout(source, worktreePath string) (cloneCheckoutReport, error) {
	var report cloneCheckoutReport
	// Before anything is read: an attributes file changed after this
	// changed what the reads below went by.
	started := time.Now().UnixNano()
	umask := processUmask()
	last := time.Now()
	lap := func(phase string) {
		vlog("[clone checkout] %s %s", phase, time.Since(last).Round(time.Millisecond))
		last = time.Now()
	}

	treeOut, err := runGit(worktreePath, "ls-tree", "-r", "-z", "--full-tree", "HEAD")
	if err != nil {
		return report, err
	}
	targets, err := parseLsTree(treeOut)
	if err != nil {
		return report, err
	}
	var targetPaths, targetOids strings.Builder
	for _, t := range targets {
		targetPaths.WriteString(t.path + "\x00")
		if t.mode != 0o160000 {
			targetOids.WriteString(t.oid + "\n")
		}
	}

	// The independent reads, at once.
	var (
		srcOut, othersOut, sizeOut, format string
		globalAttrs, infoAttrs             string
		configFiles                        []string
		conv                               conversions
		idxSec, idxNsec                    uint32
		reads                              sync.WaitGroup
		readErrs                           [7]error
	)
	reads.Go(func() {
		// The index is read between two looks at its mtime. A rewrite in
		// between (a concurrent git command) leaves the raciness cutoff
		// unknown, so nothing is cloned on its word.
		index, err := gitPath(source, "index")
		if readErrs[0] = err; err != nil {
			return
		}
		var sec, nsec uint32
		if idxSec, idxNsec, readErrs[0] = indexMtime(index); readErrs[0] != nil {
			return
		}
		if srcOut, readErrs[0] = runGit(source, "ls-files", "-s", "-z", "--debug"); readErrs[0] != nil {
			return
		}
		if sec, nsec, readErrs[0] = indexMtime(index); readErrs[0] == nil && (sec != idxSec || nsec != idxNsec) {
			readErrs[0] = errors.New("source index changed while it was read")
		}
	})
	reads.Go(func() {
		othersOut, readErrs[1] = runGit(source, "ls-files", "-z", "--others", "--directory")
	})
	// Attributes as a checkout of HEAD sees them: its .gitattributes (the
	// new worktree has none on disk yet), info/attributes, and the user's
	// own. And as the source saw them when it wrote and last hashed its
	// files, since a conversion there (a filter another commit drops)
	// means its bytes aren't the blob's.
	reads.Go(func() { conv, readErrs[2] = readConversions(source, worktreePath, targetPaths.String()) })
	reads.Go(func() {
		sizeOut, readErrs[4] = runGitStdin(worktreePath, nil, targetOids.String(),
			"cat-file", "--buffer", "--batch-check=%(objectname) %(objectsize)")
	})
	reads.Go(func() {
		format, readErrs[5] = runGit(worktreePath, "rev-parse", "--show-object-format")
	})
	reads.Go(func() {
		// Where the attributes outside the tree live, as git looks for
		// them.
		globalAttrs, _ = runGit(source, "config", "--path", "--get", "core.attributesFile")
		if globalAttrs = strings.TrimSpace(globalAttrs); globalAttrs == "" {
			if home := configHomeDir(); home != "" {
				globalAttrs = filepath.Join(home, "git", "attributes")
			}
		} else if !filepath.IsAbs(globalAttrs) {
			// As git resolves it, from the checkout.
			globalAttrs = filepath.Join(source, globalAttrs)
		}
		infoAttrs, readErrs[6] = gitPath(source, "info/attributes")
		// Config decides which attributes file is the global one, so a
		// change to any config file in effect (or to its folder, for one
		// created or deleted) may be a change to the attributes.
		origins, _ := runGit(source, "config", "--list", "--show-origin", "--name-only", "-z")
		fields := strings.Split(origins, "\x00")
		for i := 0; i+1 < len(fields); i += 2 {
			if file, ok := strings.CutPrefix(fields[i], "file:"); ok {
				if !filepath.IsAbs(file) {
					file = filepath.Join(source, file)
				}
				configFiles = append(configFiles, file)
			}
		}
		if home, err := os.UserHomeDir(); err == nil {
			configFiles = append(configFiles, filepath.Join(home, ".gitconfig"))
		}
		if home := configHomeDir(); home != "" {
			configFiles = append(configFiles, filepath.Join(home, "git", "config"))
		}
	})
	reads.Wait()
	lap("read")
	if err := errors.Join(readErrs[:]...); err != nil {
		return report, err
	}
	newHash, err := objectHash(strings.TrimSpace(format))
	if err != nil {
		return report, err
	}
	sourceEntries, err := parseLsFilesDebug(srcOut)
	if err != nil {
		return report, err
	}
	converted := checkoutConverts(conv.attr, conv.config)
	for p := range checkoutConverts(conv.srcAttr, conv.srcConfig) {
		converted[p] = true
	}
	blobSize := map[string]uint32{}
	for line := range strings.SplitSeq(sizeOut, "\n") {
		if oid, size, ok := strings.Cut(line, " "); ok {
			n, err := strconv.ParseUint(size, 10, 64)
			if err != nil {
				return report, fmt.Errorf("unexpected cat-file line %q", line)
			}
			blobSize[oid] = uint32(n)
		}
	}

	// A conflicted path's stage entries all carry stage bits in their
	// flags, which ordinaryIndexFlags turns down.
	bySourcePath := make(map[string]sourceEntry, len(sourceEntries))
	for _, e := range sourceEntries {
		bySourcePath[e.path] = e
	}
	// Names a case-insensitive disk takes for one (two files, a file
	// and a directory, two directories) are left to git, which writes
	// them in index order as a checkout does, the last one winning.
	// APFS also folds Unicode normalization, which ToLower doesn't, so
	// names outside ASCII go to git too.
	spelling := make(map[string]string, len(targets))
	colliding := map[string]bool{}
	// Whether name's spelling was already there (so its folders were
	// claimed with it).
	claim := func(name, as string) bool {
		key := strings.ToLower(name)
		prev, ok := spelling[key]
		if !ok {
			spelling[key] = as
		} else if prev != as {
			colliding[key] = true
		}
		return ok && prev == as
	}
	for _, t := range targets {
		claim(t.path, t.path)
		for d := range ancestors(t.path) {
			if claim(d, d+"/") {
				break
			}
		}
	}
	collides := func(p string) bool {
		if len(colliding) == 0 {
			return false
		}
		if colliding[strings.ToLower(p)] {
			return true
		}
		for d := range ancestors(p) {
			if colliding[strings.ToLower(d)] {
				return true
			}
		}
		return false
	}

	// What the source's index says can be cloned. The files themselves
	// are only checked against it once cloned (below).
	clonable := map[string]bool{}
	for _, t := range targets {
		s, ok := bySourcePath[t.path]
		// The blob's size too: the conversions left (CRLF to LF on the
		// way in) only ever shrink a file, so a file its blob's size
		// holds the blob's bytes, as a checkout would write them.
		size, known := blobSize[t.oid]
		if !ok || !ordinaryIndexFlags(s.flags) || t.mode == 0o160000 ||
			(t.mode == 0o120000 && !conv.config.symlinks) ||
			s.mode != t.mode || s.oid != t.oid || converted[t.path] || !isASCII(t.path) ||
			collides(t.path) || !known || s.stat.size != size ||
			!olderThan(s.stat.mtimeSec, s.stat.mtimeNsec, idxSec, idxNsec) {
			continue
		}
		clonable[t.path] = true
	}

	// A directory is cloned whole when everything in it on the source
	// side is a file being cloned: nothing untracked or ignored, nothing
	// tracked that isn't cloned, nothing the new worktree needs that
	// isn't. Each other path marks its ancestors as needing a walk.
	impure := map[string]bool{}
	markParents := func(p string) {
		for d := range ancestors(p) {
			if impure[d] {
				return
			}
			impure[d] = true
		}
	}
	for other := range strings.SplitSeq(othersOut, "\x00") {
		if other != "" {
			markParents(other)
		}
	}
	for _, e := range sourceEntries {
		if !clonable[e.path] {
			markParents(e.path)
		}
	}
	targetDirs := map[string]bool{}
	tracked := make(map[string]bool, len(targets))
	for _, t := range targets {
		tracked[t.path] = true
		if !clonable[t.path] {
			markParents(t.path)
		}
		for d := range ancestors(t.path) {
			if targetDirs[d] {
				break
			}
			targetDirs[d] = true
		}
	}

	// Each cloned path's unit: its outermost directory that can go
	// whole, else the file itself.
	units := map[string]bool{}
	parents := map[string]bool{}
	for p := range clonable {
		unit := p
		for i := 0; i < len(p); i++ {
			if p[i] == '/' && !impure[p[:i]] {
				unit = p[:i]
				break
			}
		}
		if !units[unit] {
			units[unit] = true
			if d := path.Dir(unit); d != "." {
				parents[d] = true
			}
		}
	}
	for d := range parents {
		if err := os.MkdirAll(filepath.Join(worktreePath, d), 0o777); err != nil {
			return report, err
		}
	}
	unitList := slices.Sorted(maps.Keys(units))
	if err := forEachParallel(unitList, func(u string) error {
		err := cloneTree(filepath.Join(source, u), filepath.Join(worktreePath, u))
		// Gone from the source since its index was written (or a
		// directory above it is), or not ours to read: git writes it
		// instead (the check below turns down whatever did or didn't
		// land).
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, fs.ErrPermission) {
			return nil
		}
		return err
	}); err != nil {
		return report, err
	}
	lap(fmt.Sprintf("clone (%d units)", len(unitList)))

	// A whole-directory clone also took whatever appeared in it since
	// the source was listed, and names as the source's disk spells them.
	// Anything that isn't a tracked path, spelled as git has it, goes
	// (and a tracked file gone this way goes to git below).
	if err := pruneUntracked(worktreePath, unitList, tracked, targetDirs, os.FileMode(0o777&^umask)); err != nil {
		return report, err
	}
	lap("prune")

	// When the attributes that apply to a path last changed, as far as
	// ctimes (the kernel's, so no tool sets them back) can tell: each
	// attributes file's, and its folder's, which moves whenever an entry
	// in it is added, removed or renamed, so a deleted .gitattributes
	// shows there too. For a path in the tree that's every folder above
	// it. A source file git last checked after all of them was checked
	// under the attributes in force now, which the conversion checks
	// above went by. One checked before may hold bytes a conversion since
	// dropped made (a filter or an encoding, which can keep the size), so
	// its clone is read back and hashed, once: the record below keeps
	// the proof for as long as the file stays as it is. (A tracked
	// .gitattributes long gone from disk is read from the index, by git
	// and by the conversion checks alike.)
	newest := int64(0)
	ctimeOf := func(p string) int64 {
		var st unix.Stat_t
		if unix.Lstat(p, &st) != nil {
			return 0
		}
		t := st.Ctim.Sec*1e9 + st.Ctim.Nsec
		newest = max(newest, t)
		return t
	}
	fileAndFolder := func(p string) int64 {
		if p == "" {
			return 0
		}
		return max(ctimeOf(p), ctimeOf(filepath.Dir(p)))
	}
	attrsOf := func(dir string) int64 {
		return fileAndFolder(filepath.Join(source, dir, ".gitattributes"))
	}
	// A config file's own ctime, or its folder's when it's gone (a
	// deleted include). A new one has a ctime of its own. Left out of
	// `newest` (the mid-clone guard): the folders include the home
	// folder, which changes all the time, and a file stale for no reason
	// only costs one read back.
	configChanged := int64(0)
	for _, f := range configFiles {
		var st unix.Stat_t
		if unix.Lstat(f, &st) == nil || unix.Lstat(filepath.Dir(f), &st) == nil {
			configChanged = max(configChanged, st.Ctim.Sec*1e9+st.Ctim.Nsec)
		}
	}
	attrsChanged := map[string]int64{".": max(configChanged, fileAndFolder(globalAttrs), fileAndFolder(infoAttrs), attrsOf("."))}
	// git doesn't look past a symlinked directory for a tracked path,
	// and neither does this: a source path is only taken when each
	// directory above it is a real one. (One reached through a symlink
	// that still matches its record is the same file, so this keeps to
	// git's view more than it guards the bytes.)
	realDir := map[string]bool{".": true}
	// Parents sort before their children.
	folders := map[string]bool{}
	for p := range clonable {
		for d := range ancestors(p) {
			if folders[d] {
				break
			}
			folders[d] = true
		}
	}
	for _, d := range slices.Sorted(maps.Keys(folders)) {
		info, err := os.Lstat(filepath.Join(source, d))
		realDir[d] = err == nil && info.IsDir() && realDir[path.Dir(d)]
		attrsChanged[d] = max(attrsChanged[path.Dir(d)], attrsOf(d))
	}
	// Attributes that changed while this ran (or a folder above a cloned
	// path, which may be one deleted) may make a checkout write what the
	// conversion checks didn't expect. They're read again: git checks out
	// with the ones in force now if they differ. (The files under those
	// folders are stale now, so their bytes get proven either way.)
	if newest >= started {
		if again, err := readConversions(source, worktreePath, targetPaths.String()); err != nil || again != conv {
			return report, errors.New("attributes changed while cloning")
		}
	}

	// Files git last checked before the attributes changed, which are
	// proven by hashing unless an earlier clone proved that very
	// version (cloneVerified).
	// Strictly before: a change at the very instant the file last changed
	// is that change (its own folder entry, or the file being an
	// attributes file itself).
	stale := func(p string) bool {
		st := bySourcePath[p].stat
		return int64(st.ctimeSec)*1e9+int64(st.ctimeNsec) < attrsChanged[path.Dir(p)]
	}
	var verified map[string]string
	var verifiedAt time.Time
	for p := range clonable {
		if stale(p) {
			verified, verifiedAt = readCloneVerified(source)
			break
		}
	}
	proven := map[string]string{}

	// Each clone is kept only if the source file still has the stat its
	// index entry recorded when git last hashed it. A write moves ctime
	// forward for good, so an unchanged ctime means the file wasn't
	// touched before or during its clone. And only if it carries nothing
	// a checkout wouldn't give it: the permissions git creates files
	// with, no file flags or extended attributes. Anything else goes to
	// git.
	var mu sync.Mutex
	hashed := 0
	cloned := make(map[string]indexStat, len(clonable))
	if err := forEachParallel(slices.Collect(maps.Keys(clonable)), func(p string) error {
		src, dst := filepath.Join(source, p), filepath.Join(worktreePath, p)
		// A clone turned down is removed for git to write afresh: it may
		// carry what git can't overwrite (a flag, a directory it can't
		// get into).
		reject := func() error { return forceRemoveAll(dst) }
		var raw unix.Stat_t
		if !realDir[path.Dir(p)] || unix.Lstat(src, &raw) != nil {
			return reject()
		}
		after, entry := indexStatOf(&raw), bySourcePath[p]
		if !after.sameFile(entry.stat) || !after.matchesMode(entry.mode) ||
			!checkedOutPerm(after, entry.mode, umask) || !plainAsCheckedOut(src, &raw) {
			return reject()
		}
		st, err := lstatIndex(dst)
		// clonefile keeps the mtime and mode: anything else isn't our
		// clone.
		if err != nil || st.mtimeSec != after.mtimeSec || st.mtimeNsec != after.mtimeNsec ||
			st.size != after.size || st.mode != after.mode {
			return reject()
		}
		var record string
		if stale(p) {
			if record = verifiedRecord(entry.oid, entry.stat); verified[p] == record {
				record = ""
			} else {
				mu.Lock()
				hashed++
				mu.Unlock()
				if oid, err := blobID(dst, entry.mode, newHash); err != nil || oid != entry.oid {
					return reject()
				}
			}
		}
		mu.Lock()
		cloned[p] = st
		if record != "" {
			proven[p] = record
		}
		mu.Unlock()
		return nil
	}); err != nil {
		return report, err
	}
	lap("verify")

	// Git writes the rest, submodules' empty directories included, in
	// index order as a checkout would.
	var toGit []string
	for _, t := range targets {
		if _, ok := cloned[t.path]; !ok {
			toGit = append(toGit, t.path)
		}
	}
	report.Cloned = len(cloned)
	report.Hashed = hashed
	if len(proven) > 0 {
		// Best effort: without it the next clone reads them again.
		if err := updateCloneVerified(source, verified, verifiedAt, proven, func(p, record string) bool {
			e, ok := bySourcePath[p]
			return ok && verifiedRecord(e.oid, e.stat) == record
		}); err != nil {
			vlog("[clone checkout] record verified files: %v", err)
		}
	}
	report.Written = len(toGit)

	if err := writeIndex(worktreePath, targets, cloned, newHash()); err != nil {
		return report, err
	}
	lap("write index")
	if len(toGit) > 0 {
		// -f: a path cloned and then rejected above is overwritten. -u
		// records the written files' stat in the index.
		if _, err := runGitStdin(worktreePath, nil, strings.Join(toGit, "\x00"),
			"checkout-index", "-f", "-u", "-z", "--stdin"); err != nil {
			return report, err
		}
		lap("checkout-index")
	}
	return report, nil
}

// Walks the whole-directory clones and removes whatever isn't a
// tracked file or a directory leading to one, giving each directory
// what a checkout creates it with (normalizeClonedDir).
func pruneUntracked(worktreePath string, units []string, tracked, targetDirs map[string]bool, dirMode os.FileMode) error {
	var walk func(rel string) error
	walk = func(rel string) error {
		full := filepath.Join(worktreePath, rel)
		info, err := os.Lstat(full)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		// The source has something else where the commit has this
		// directory.
		if !info.IsDir() {
			return forceRemoveAll(full)
		}
		if err := normalizeClonedDir(full, uint32(dirMode)); err != nil {
			return err
		}
		entries, err := os.ReadDir(full)
		if err != nil {
			return err
		}
		for _, e := range entries {
			child := rel + "/" + e.Name()
			switch {
			case e.IsDir() && targetDirs[child]:
				if err := walk(child); err != nil {
					return err
				}
			case !e.IsDir() && tracked[child]:
			default:
				if err := forceRemoveAll(filepath.Join(worktreePath, child)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	var dirs []string
	for _, u := range units {
		if targetDirs[u] {
			dirs = append(dirs, u)
		}
	}
	return forEachParallel(dirs, walk)
}

// RemoveAll for what a clone can leave: a flag pinning a file, a
// directory that can't be listed or emptied (unpin).
func forceRemoveAll(p string) error {
	if os.RemoveAll(p) == nil {
		return nil
	}
	// The walk unpins each directory before reading it.
	_ = filepath.WalkDir(p, func(q string, _ fs.DirEntry, _ error) error {
		unpin(q)
		return nil
	})
	return os.RemoveAll(p)
}

// The permission bits git gives a file it writes, under this umask:
// what a source file has to carry for its clone to pass as checked out.
func checkedOutPerm(st indexStat, mode, umask uint32) bool {
	switch mode {
	case 0o100644:
		return st.mode&0o7777 == 0o666&^umask
	case 0o100755:
		return st.mode&0o7777 == 0o777&^umask
	}
	return true // a symlink's own bits mean nothing
}

var processUmask = sync.OnceValue(func() uint32 {
	// The only way to read it is to set it. Nothing else here creates
	// files while it's briefly 0.
	old := unix.Umask(0)
	unix.Umask(old)
	return uint32(old)
})

// The repo's object hash, by `rev-parse --show-object-format`.
func objectHash(format string) (func() hash.Hash, error) {
	switch format {
	case "sha1":
		return sha1.New, nil
	case "sha256":
		return sha256.New, nil
	}
	return nil, fmt.Errorf("unknown object format %q", format)
}

// The object id git gives the file at p as a blob of this mode, its
// bytes taken as they are (no filters): a symlink's target, a file's
// content.
func blobID(p string, mode uint32, newHash func() hash.Hash) (string, error) {
	h := newHash()
	if mode == 0o120000 {
		target, err := os.Readlink(p)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "blob %d\x00%s", len(target), target)
		return hex.EncodeToString(h.Sum(nil)), nil
	}
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	fmt.Fprintf(h, "blob %d\x00", info.Size())
	if n, err := io.Copy(h, f); err != nil || n != info.Size() {
		return "", cmp.Or(err, errors.New("file changed size while hashed"))
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Writes the worktree's index (version 2, no extensions, as git adds
// what it wants on its next write) with the given stat per path. Paths
// without one get zeroes, which git reads as "changed" until
// checkout-index fills them in.
func writeIndex(worktreePath string, entries []treeEntry, stats map[string]indexStat, sum hash.Hash) error {
	sorted := slices.SortedFunc(slices.Values(entries), func(a, b treeEntry) int {
		return strings.Compare(a.path, b.path)
	})

	var buf bytes.Buffer
	be := func(v uint32) { _ = binary.Write(&buf, binary.BigEndian, v) }
	buf.WriteString("DIRC")
	be(2)
	be(uint32(len(sorted)))
	for _, e := range sorted {
		st := stats[e.path]
		for _, v := range []uint32{
			st.ctimeSec, st.ctimeNsec, st.mtimeSec, st.mtimeNsec,
			st.dev, st.ino, e.mode, st.uid, st.gid, st.size,
		} {
			be(v)
		}
		oid, err := hex.DecodeString(e.oid)
		if err != nil || len(oid) != sum.Size() {
			return fmt.Errorf("bad object id %q for %s", e.oid, e.path)
		}
		buf.Write(oid)
		_ = binary.Write(&buf, binary.BigEndian, uint16(min(len(e.path), 0xFFF)))
		buf.WriteString(e.path)
		// NUL-padded to a multiple of eight, with at least one NUL.
		n := 40 + len(oid) + 2 + len(e.path)
		buf.Write(make([]byte, 8-n%8))
	}
	sum.Write(buf.Bytes())
	buf.Write(sum.Sum(nil))

	indexPath, err := gitPath(worktreePath, "index")
	if err != nil {
		return err
	}
	// Through git's own lock file, so a concurrent git in this
	// worktree fails cleanly instead of losing a write.
	lock := indexPath + ".lock"
	f, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return err
	}
	_, werr := f.Write(buf.Bytes())
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(lock)
		return werr
	}
	return os.Rename(lock, indexPath)
}
