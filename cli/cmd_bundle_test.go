package main

// Tests for the bundle create/unpack transfer primitive
// (cmd_bundle.go). Fixtures are real repos related by `git clone`, so
// haves/thin-bundle behavior is exercised against a genuinely shared
// history, and assertions go through git plumbing (rev-parse,
// for-each-ref, cat-file), matching the house style.

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A source repo with a base commit on main plus a "work" branch commit
// and a dirty-capture-style ref, and a clone that holds only the base:
// the receiving device in the sync flow.
func seedBundleFixture(t *testing.T) (srcPath, dstPath, base, workTip, captureTip string) {
	t.Helper()
	parent := t.TempDir()
	srcPath = seedRepo(t, parent, "src")
	writeFileT(t, filepath.Join(srcPath, "a.txt"), "alpha\n")
	runGitT(t, srcPath, "add", "-A")
	runGitT(t, srcPath, "commit", "-qm", "base")
	base = strings.TrimSpace(gitOut(t, srcPath, "rev-parse", "HEAD"))

	dstPath = filepath.Join(parent, "dst")
	runGitT(t, parent, "clone", "-q", "--", srcPath, dstPath)
	// No background housekeeping: fetch spawns a detached
	// `git maintenance run --auto` whose repack races t.TempDir's
	// cleanup, failing RemoveAll on a still-populated .git.
	for _, repo := range []string{srcPath, dstPath} {
		runGitT(t, repo, "config", "gc.auto", "0")
		runGitT(t, repo, "config", "maintenance.auto", "false")
	}

	runGitT(t, srcPath, "checkout", "-q", "-b", "work")
	writeFileT(t, filepath.Join(srcPath, "b.txt"), "branch work\n")
	runGitT(t, srcPath, "add", "-A")
	runGitT(t, srcPath, "commit", "-qm", "work")
	workTip = strings.TrimSpace(gitOut(t, srcPath, "rev-parse", "HEAD"))

	// A capture-shaped ref on top of the work tip, the other ref kind
	// the sync flow moves.
	writeFileT(t, filepath.Join(srcPath, "c.txt"), "dirty\n")
	runGitT(t, srcPath, "add", "-A")
	runGitT(t, srcPath, "commit", "-qm", "capture")
	captureTip = strings.TrimSpace(gitOut(t, srcPath, "rev-parse", "HEAD"))
	runGitT(t, srcPath, "update-ref", "refs/shigomori/dirty/aaaabbbbcccc", captureTip)
	runGitT(t, srcPath, "checkout", "-q", "main")
	runGitT(t, srcPath, "branch", "-q", "-f", "work", workTip)
	return srcPath, dstPath, base, workTip, captureTip
}

func mustCreateBundle(t *testing.T, srcPath string, refs, haves []string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "transfer.bundle")
	res, err := createBundle(srcPath, out, refs, haves)
	if err != nil {
		t.Fatalf("createBundle: %v", err)
	}
	if res.path != out || res.bytes <= 0 {
		t.Fatalf("create result = %+v, want path %s and positive bytes", res, out)
	}
	return out
}

// All refs in a repo as refname->sha. The tag-auto-follow proof
// snapshots this before and after unpack: the delta must be exactly the
// wanted refs, so a stray refs/tags/* shows up as an unexpected entry.
func refSet(t *testing.T, repo string) map[string]string {
	t.Helper()
	out := gitOut(t, repo, "for-each-ref", "--format=%(refname) %(objectname)")
	refs := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		name, sha, _ := strings.Cut(line, " ")
		refs[name] = sha
	}
	return refs
}

// Refs present in after with a tip that before lacked: what an unpack
// added or moved.
func refDelta(before, after map[string]string) map[string]string {
	delta := map[string]string{}
	for name, sha := range after {
		if before[name] != sha {
			delta[name] = sha
		}
	}
	return delta
}

// The full round trip: both ref kinds land in the receiver under
// refs/shigomori/ with the source's exact tips, and the transferred
// blob is byte-identical via cat-file.
func TestBundleRoundTripPreservesTips(t *testing.T) {
	srcPath, dstPath, _, workTip, captureTip := seedBundleFixture(t)
	refs := []string{"refs/heads/work", "refs/shigomori/dirty/aaaabbbbcccc"}
	bundle := mustCreateBundle(t, srcPath, refs, nil)

	res, err := unpackBundle(dstPath, bundle, []string{
		"refs/heads/work:refs/shigomori/incoming/work",
		"refs/shigomori/dirty/aaaabbbbcccc:refs/shigomori/dirty/aaaabbbbcccc",
	})
	if err != nil {
		t.Fatalf("unpackBundle: %v", err)
	}
	want := map[string]string{
		"refs/shigomori/incoming/work":      workTip,
		"refs/shigomori/dirty/aaaabbbbcccc": captureTip,
	}
	if len(res.fetched) != 2 {
		t.Fatalf("fetched = %+v, want 2 refs", res.fetched)
	}
	for _, tip := range res.fetched {
		if want[tip.Ref] != tip.Commit {
			t.Errorf("fetched %s = %s, want %s", tip.Ref, tip.Commit, want[tip.Ref])
		}
		got := strings.TrimSpace(gitOut(t, dstPath, "rev-parse", "--verify", tip.Ref))
		if got != want[tip.Ref] {
			t.Errorf("receiver %s = %s, want %s", tip.Ref, got, want[tip.Ref])
		}
	}
	// Byte-for-byte object equality across the transfer.
	srcBlob := gitOut(t, srcPath, "cat-file", "blob", workTip+":b.txt")
	dstBlob := gitOut(t, dstPath, "cat-file", "blob", workTip+":b.txt")
	if srcBlob != dstBlob || dstBlob != "branch work\n" {
		t.Errorf("blob mismatch across transfer: src %q dst %q", srcBlob, dstBlob)
	}
	// No branch materialized on the receiver.
	if refExists(dstPath, "refs/heads/work") {
		t.Error("unpack created refs/heads/work on the receiver")
	}
}

// Haves thin the bundle against tips the receiver already holds, and
// the thin bundle still applies cleanly there.
func TestBundleCreateWithHavesIsThinAndApplies(t *testing.T) {
	srcPath, dstPath, base, workTip, _ := seedBundleFixture(t)
	refs := []string{"refs/heads/work"}
	full := mustCreateBundle(t, srcPath, refs, nil)
	thin := mustCreateBundle(t, srcPath, refs, []string{base})

	fullInfo, _ := os.Stat(full)
	thinInfo, _ := os.Stat(thin)
	if thinInfo.Size() >= fullInfo.Size() {
		t.Errorf("thin bundle (%d bytes) not smaller than full (%d bytes)", thinInfo.Size(), fullInfo.Size())
	}
	res, err := unpackBundle(dstPath, thin, []string{"refs/heads/work:refs/shigomori/incoming/work"})
	if err != nil {
		t.Fatalf("unpack of thin bundle: %v", err)
	}
	if res.fetched[0].Commit != workTip {
		t.Errorf("thin unpack tip = %s, want %s", res.fetched[0].Commit, workTip)
	}
}

// A have this repo has never heard of (the receiver's tip) is skipped
// with a note, never an error.
func TestBundleCreateSkipsUnknownHave(t *testing.T) {
	srcPath, _, base, _, _ := seedBundleFixture(t)
	out := filepath.Join(t.TempDir(), "transfer.bundle")
	unknown := strings.Repeat("d", 40)
	res, err := createBundle(srcPath, out, []string{"refs/heads/work"}, []string{unknown, base})
	if err != nil {
		t.Fatalf("createBundle: %v", err)
	}
	if len(res.skippedHaves) != 1 || res.skippedHaves[0] != unknown {
		t.Errorf("skippedHaves = %v, want [%s]", res.skippedHaves, unknown)
	}
}

// Create fails closed on refs: unknown refs are coded errors, and a
// ref outside the conservative shape never reaches git argv.
func TestBundleCreateRefusesBadRefs(t *testing.T) {
	srcPath, _, _, _, _ := seedBundleFixture(t)
	out := filepath.Join(t.TempDir(), "transfer.bundle")
	if _, err := createBundle(srcPath, out, []string{"refs/heads/nope"}, nil); errorKindOf(err) != "unknown-ref" {
		t.Errorf("unknown ref error kind = %q, want unknown-ref", errorKindOf(err))
	}
	for _, bad := range []string{"work", "--all", "refs/heads/a..b", "refs/heads/x.lock", "refs/heads/x/"} {
		if _, err := createBundle(srcPath, out, []string{bad}, nil); errorKindOf(err) != "bad-ref" {
			t.Errorf("ref %q error kind = %q, want bad-ref", bad, errorKindOf(err))
		}
	}
	if _, err := createBundle(srcPath, out, []string{"refs/heads/work"}, []string{"--exclude=x"}); errorKindOf(err) != "bad-have" {
		t.Error("a flag-shaped have was not refused")
	}
}

// The invariant that matters: unpack can never move refs/heads/* or
// anything else outside refs/shigomori/. Fail-closed before any git
// spawn, branch untouched, nothing fetched.
func TestBundleUnpackRefusesDstOutsideShigomori(t *testing.T) {
	srcPath, dstPath, base, _, _ := seedBundleFixture(t)
	bundle := mustCreateBundle(t, srcPath, []string{"refs/heads/work"}, nil)
	mainBefore := strings.TrimSpace(gitOut(t, dstPath, "rev-parse", "refs/heads/main"))
	if mainBefore != base {
		t.Fatalf("fixture drift: receiver main = %s, want %s", mainBefore, base)
	}
	for _, spec := range []string{
		"refs/heads/work:refs/heads/main",
		"refs/heads/work:refs/heads/work",
		"refs/heads/work:refs/remotes/origin/main",
		"refs/heads/work:refs/shigomori-evil/x",
		"refs/heads/work",
		"refs/heads/work:refs/shigomori/../heads/main",
	} {
		if _, err := unpackBundle(dstPath, bundle, []string{spec}); errorKindOf(err) != "bad-refspec" {
			t.Errorf("refspec %q error kind = %q, want bad-refspec", spec, errorKindOf(err))
		}
	}
	if got := strings.TrimSpace(gitOut(t, dstPath, "rev-parse", "refs/heads/main")); got != mainBefore {
		t.Errorf("refused unpack moved main: %s -> %s", mainBefore, got)
	}
	if refExists(dstPath, "refs/heads/work") {
		t.Error("refused unpack created a branch")
	}
	refs := gitOut(t, dstPath, "for-each-ref", "--format=%(refname)", "refs/shigomori")
	if strings.TrimSpace(refs) != "" {
		t.Errorf("refused unpack fetched into refs/shigomori: %q", refs)
	}
}

// The invariant M1 restored: a peer-supplied bundle can advertise
// annotated tags, and git fetch auto-follows a tag whose target lands in
// the fetched history. Without --no-tags a hostile bundle could plant
// refs/tags/main (tags outrank branches in bare-name resolution) and
// hijack `git checkout main` / `git log main` on the receiver. unpack
// disables tag auto-follow, so ONLY the explicit refspec lands and no
// ref outside refs/shigomori/ ever appears.
func TestBundleUnpackDisablesTagAutoFollow(t *testing.T) {
	srcPath, dstPath, _, workTip, _ := seedBundleFixture(t)
	// A real annotated tag named "main", pointing at the tip we transfer
	// so its object IS downloaded by the branch fetch -- the exact
	// condition that triggers auto-follow. The name collides with the
	// receiver's main branch on purpose: that is the hijack.
	runGitT(t, srcPath, "tag", "-a", "-m", "hostile", "main", workTip)
	// Craft the bundle by hand, the way a hostile granted peer's bytes
	// would: advertise the tag in the bundle header alongside the branch.
	// createBundle is the sender we trust; this is the RECEIVER-side
	// guard, so bypass the sender and feed unpack the raw bundle.
	bundle := filepath.Join(t.TempDir(), "hostile.bundle")
	runGitT(t, srcPath, "bundle", "create", bundle, "refs/heads/work", "refs/tags/main")

	before := refSet(t, dstPath)
	res, err := unpackBundle(dstPath, bundle, []string{"refs/heads/work:refs/shigomori/incoming/work"})
	if err != nil {
		t.Fatalf("unpackBundle: %v", err)
	}
	if len(res.fetched) != 1 || res.fetched[0].Commit != workTip {
		t.Fatalf("fetched = %+v, want only the work tip %s", res.fetched, workTip)
	}
	if refExists(dstPath, "refs/tags/main") {
		t.Error("unpack auto-followed a tag: refs/tags/main appeared on the receiver")
	}
	// The ref set grew by EXACTLY the one wanted ref under
	// refs/shigomori/ -- nothing else, no tag, materialized.
	appeared := refDelta(before, refSet(t, dstPath))
	want := map[string]string{"refs/shigomori/incoming/work": workTip}
	if !reflect.DeepEqual(appeared, want) {
		t.Errorf("unpack changed refs beyond the wanted set: got %v, want %v", appeared, want)
	}
}

// A corrupted bundle fails verify with the coded kind, before any
// fetch can run.
func TestBundleUnpackRefusesCorruptedBundle(t *testing.T) {
	srcPath, dstPath, _, _, _ := seedBundleFixture(t)
	bundle := mustCreateBundle(t, srcPath, []string{"refs/heads/work"}, nil)
	data, err := os.ReadFile(bundle)
	if err != nil {
		t.Fatal(err)
	}
	// Flip bytes in the pack payload so verify's checksum fails.
	for i := len(data) / 2; i < len(data)/2+8 && i < len(data); i++ {
		data[i] ^= 0xff
	}
	if err := os.WriteFile(bundle, data, 0o644); err != nil {
		t.Fatal(err)
	}
	_, unpackErr := unpackBundle(dstPath, bundle, []string{"refs/heads/work:refs/shigomori/incoming/work"})
	if errorKindOf(unpackErr) != "bad-bundle" {
		t.Errorf("corrupted bundle error kind = %q (%v), want bad-bundle", errorKindOf(unpackErr), unpackErr)
	}
	if refExists(dstPath, "refs/shigomori/incoming/work") {
		t.Error("a corrupted bundle still fetched a ref")
	}
}

// Re-unpacking after the source rewrote a capture in place (no
// fast-forward relation) still lands: the forced fetch is what makes
// overwrite-in-place refs transferable.
func TestBundleUnpackForceUpdatesRewrittenCapture(t *testing.T) {
	srcPath, dstPath, _, _, _ := seedBundleFixture(t)
	ref := "refs/shigomori/dirty/aaaabbbbcccc"
	first := mustCreateBundle(t, srcPath, []string{ref}, nil)
	if _, err := unpackBundle(dstPath, first, []string{ref + ":" + ref}); err != nil {
		t.Fatalf("first unpack: %v", err)
	}
	// Rewrite the capture to a sibling commit (same parent, different
	// tree), the shape a re-capture produces.
	runGitT(t, srcPath, "checkout", "-q", "work")
	writeFileT(t, filepath.Join(srcPath, "d.txt"), "other dirt\n")
	runGitT(t, srcPath, "add", "-A")
	runGitT(t, srcPath, "commit", "-qm", "recapture")
	rewritten := strings.TrimSpace(gitOut(t, srcPath, "rev-parse", "HEAD"))
	runGitT(t, srcPath, "update-ref", ref, rewritten)
	runGitT(t, srcPath, "checkout", "-q", "main")

	second := mustCreateBundle(t, srcPath, []string{ref}, nil)
	res, err := unpackBundle(dstPath, second, []string{ref + ":" + ref})
	if err != nil {
		t.Fatalf("second unpack: %v", err)
	}
	if res.fetched[0].Commit != rewritten {
		t.Errorf("rewritten capture tip = %s, want %s", res.fetched[0].Commit, rewritten)
	}
}
