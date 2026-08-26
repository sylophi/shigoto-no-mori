package main

// sm bundle create / unpack: the git-data transfer primitive device
// sync is built on. create writes a git bundle holding the requested
// refs (optionally thinned against --have tips the receiver already
// holds); unpack verifies a bundle and fetches requested refs out of
// it, but ONLY into the refs/shigomori/ namespace: unpack fetches the
// explicit refspecs and NOTHING else, with tag auto-follow disabled
// (--no-tags), so no ref outside refs/shigomori/ can ever land. It can
// never move refs/heads/*, refs/tags/*, or any other ref, so a
// peer-influenced unpack cannot touch a branch or a bare-name lookup.
// Landing fetched work on a real branch is the sync orchestration's
// job, done deliberately from the safe namespace.
//
// App plumbing, not in the help catalog: the app invokes these with
// app-chosen temp paths. The CLI writes/reads exactly where --out/--in
// say (that trust boundary is the host handler's: it owns path choice
// and hands us paths under its own temp directory). Refs and haves ARE
// validated here fail-closed regardless of caller, because on the
// receiving device they originate from a remote peer.

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Conservative full-ref shape: must live under refs/, safe charset,
// no "..", no "//", no trailing "/" or ".lock". Stricter than git's
// check-ref-format on purpose -- these strings cross a device boundary
// into argv, so fail closed and let git reject the exotic rest.
var bundleRefRe = regexp.MustCompile(`^refs/[A-Za-z0-9][A-Za-z0-9._/-]*$`)

func validBundleRef(ref string) bool {
	return bundleRefRe.MatchString(ref) &&
		!strings.Contains(ref, "..") &&
		!strings.Contains(ref, "//") &&
		!strings.HasSuffix(ref, "/") &&
		!strings.HasSuffix(ref, ".lock")
}

// Mirrors COMMIT_HASH_RE in shared/schemas/worktree.ts: hex only, so a
// have can never occupy a flag position (and ^-prefixing it stays a
// revision exclusion, never an option).
var bundleHaveRe = regexp.MustCompile(`^[0-9a-f]{4,64}$`)

// The only namespace unpack may write. Everything below it is
// shigomori-owned bookkeeping (dirty captures, incoming branch tips),
// never a branch, which is what makes the forced fetch safe.
const shigomoriRefPrefix = "refs/shigomori/"

type bundleRefTip struct {
	Ref    string `json:"ref"`
	Commit string `json:"commit"`
}

type bundleCreateResult struct {
	path         string
	bytes        int64
	refs         []bundleRefTip
	skippedHaves []string
}

func resolveRefTips(projectPath string, refs []string) ([]bundleRefTip, error) {
	tips := make([]bundleRefTip, 0, len(refs))
	for _, ref := range refs {
		out, err := runGit(projectPath, "rev-parse", "--verify", "--end-of-options", ref)
		if err != nil {
			return nil, err
		}
		tips = append(tips, bundleRefTip{Ref: ref, Commit: strings.TrimSpace(out)})
	}
	return tips, nil
}

// Builds `git bundle create <out> ^<have>... <ref>...`. Haves the local
// object store doesn't know are skipped, not fatal: they describe the
// RECEIVER's tips, which this repo may never have heard of, and a
// missing have only costs bundle size.
func createBundle(projectPath, out string, refs, haves []string) (bundleCreateResult, error) {
	for _, ref := range refs {
		if !validBundleRef(ref) {
			return bundleCreateResult{}, codedErrf("bad-ref", "Invalid ref %q.", ref)
		}
		if !refExists(projectPath, ref) {
			return bundleCreateResult{}, codedErrf("unknown-ref", "Ref %q does not exist here.", ref)
		}
	}
	var kept, skipped []string
	for _, have := range haves {
		if !bundleHaveRe.MatchString(have) {
			return bundleCreateResult{}, codedErrf("bad-have", "Invalid have %q (must be a hex commit hash).", have)
		}
		if _, err := runGit(projectPath, "rev-parse", "--verify", "--quiet", "--end-of-options", have+"^{commit}"); err != nil {
			skipped = append(skipped, have)
			continue
		}
		kept = append(kept, have)
	}
	// --end-of-options pins everything after it to the revision slot
	// (house argv discipline, see captureDirtyState). ^<have> stays a
	// revision exclusion there; the hex guard above already made a
	// flag-shaped have impossible.
	args := []string{"bundle", "create", out, "--end-of-options"}
	for _, have := range kept {
		args = append(args, "^"+have)
	}
	args = append(args, refs...)
	if _, err := runGit(projectPath, args...); err != nil {
		return bundleCreateResult{}, err
	}
	info, err := os.Stat(out)
	if err != nil {
		return bundleCreateResult{}, err
	}
	tips, err := resolveRefTips(projectPath, refs)
	if err != nil {
		return bundleCreateResult{}, err
	}
	return bundleCreateResult{path: out, bytes: info.Size(), refs: tips, skippedHaves: skipped}, nil
}

type bundleUnpackResult struct {
	fetched []bundleRefTip
}

// Verifies the bundle, then fetches each <src>:<dst> refspec out of it.
// Every dst MUST sit under refs/shigomori/ -- validated fail-closed
// before any git spawn, so unpack structurally cannot move a branch.
// The fetch runs --no-tags so a peer-supplied bundle cannot smuggle a
// refs/tags/* into existence via git's tag auto-follow.
// The fetch is forced ('+'): dsts are shigomori-owned refs that
// overwrite in place by design (dirty captures have no history), and
// forcing a namespace no branch lives in destroys nothing a user owns.
func unpackBundle(projectPath, in string, refspecs []string) (bundleUnpackResult, error) {
	var fetchSpecs []string
	var dsts []string
	for _, spec := range refspecs {
		src, dst, ok := strings.Cut(spec, ":")
		if !ok || !validBundleRef(src) || !validBundleRef(dst) || !strings.HasPrefix(dst, shigomoriRefPrefix) {
			return bundleUnpackResult{}, codedErrf("bad-refspec",
				"Invalid refspec %q: need <src>:<dst> full refs with dst under %s.", spec, shigomoriRefPrefix)
		}
		fetchSpecs = append(fetchSpecs, "+"+src+":"+dst)
		dsts = append(dsts, dst)
	}
	// verify catches a bad header and missing prerequisites cheaply, but
	// NOT mid-pack corruption -- index-pack finds that during the fetch.
	// Both failures mean the same thing to the caller (the transferred
	// file is not a usable bundle), so both carry the coded kind.
	if _, err := runGit(projectPath, "bundle", "verify", "--end-of-options", in); err != nil {
		return bundleUnpackResult{}, codedErrf("bad-bundle", "Not a valid git bundle: %v", err)
	}
	// --no-tags is load bearing, not tidiness: git fetch auto-follows
	// annotated tags a bundle advertises, and the bundle is peer-supplied
	// bytes, so without it a hostile bundle could land refs/tags/* (which
	// outrank branches in bare-name resolution) OUTSIDE refs/shigomori/,
	// hijacking `git checkout main` and friends on the receiver. With it,
	// only the explicit refspecs above are fetched, all into
	// refs/shigomori/ by the dst guard.
	fetchArgs := append([]string{"fetch", "--no-tags", "--no-write-fetch-head", "--quiet", "--end-of-options", in}, fetchSpecs...)
	if _, err := runGit(projectPath, fetchArgs...); err != nil {
		return bundleUnpackResult{}, codedErrf("bad-bundle", "Couldn't fetch from the bundle: %v", err)
	}
	tips, err := resolveRefTips(projectPath, dsts)
	if err != nil {
		return bundleUnpackResult{}, err
	}
	return bundleUnpackResult{fetched: tips}, nil
}

func cmdBundle(ctx cliContext, args []string) (int, error) {
	spec := argSpec{
		strings: map[string][]string{
			"project":    {"p"},
			"project-id": {},
			"out":        {},
			"in":         {},
		},
		bools: map[string][]string{},
		lists: map[string][]string{"ref": {}, "have": {}, "refspec": {}},
	}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	verb := parsed.positional(0)
	if verb != "create" && verb != "unpack" {
		return 2, usageErrf(
			"Usage: %s bundle create --out <path> --ref <fullRef>... [--have <sha>...] | %s bundle unpack --in <path> --refspec <src>:<dst>...",
			binaryName, binaryName)
	}
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}

	if verb == "create" {
		outPath := parsed.strings["out"]
		refs := parsed.lists["ref"]
		if outPath == "" || strings.HasPrefix(outPath, "-") || len(refs) == 0 {
			return 2, usageErrf("Usage: %s bundle create --out <path> --ref <fullRef>... [--have <sha>...]", binaryName)
		}
		res, err := createBundle(proj.Path, outPath, refs, parsed.lists["have"])
		if err != nil {
			return exitCodeOf(err), err
		}
		for _, have := range res.skippedHaves {
			note(fmt.Sprintf("skipping unknown have %s", have))
		}
		if jsonMode {
			emit(map[string]any{
				"ok": true, "path": res.path, "bytes": res.bytes,
				"refs": res.refs, "skippedHaves": res.skippedHaves,
			})
		} else {
			out(greenOut(fmt.Sprintf("bundled %d ref(s) (%d bytes) to %s", len(res.refs), res.bytes, res.path)))
		}
		return 0, nil
	}

	in := parsed.strings["in"]
	refspecs := parsed.lists["refspec"]
	if in == "" || strings.HasPrefix(in, "-") || len(refspecs) == 0 {
		return 2, usageErrf("Usage: %s bundle unpack --in <path> --refspec <src>:<dst>...", binaryName)
	}
	res, err := unpackBundle(proj.Path, in, refspecs)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "fetched": res.fetched})
	} else {
		out(greenOut(fmt.Sprintf("fetched %d ref(s) from %s", len(res.fetched), in)))
	}
	return 0, nil
}
