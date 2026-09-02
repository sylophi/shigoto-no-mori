package main

// Carry-over, ported from host/lib/worktrees/{carryOver,
// worktreeInclude}.ts and host/lib/git/{branches,exclude}.ts: manual
// entries (symlink/copy) from project.json merged with the repo's
// .worktreeinclude resolution, applied best-effort into the new
// worktree, with directory symlinks hidden via .git/info/exclude.
//
// Known delta vs the app: the app also rewrites project.json to drop
// manual entries now covered by .worktreeinclude (reconciliation).
// The CLI skips that write-back -- mergeCarryOver dedupes at apply
// time, so behavior in the worktree is identical; only the app's
// Configure view tidy-up is app-only.

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

type carryOverFailure struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	// The checkout the failure is about, when it isn't the primary
	// (a sibling's broken .worktreeinclude).
	Source string `json:"source,omitempty"`
}

// An entry that was found somewhere other than the primary checkout,
// so the user can tell which sibling's file they ended up with.
// CopiedInstead: the entry asked for a symlink, but links only ever
// target the primary (a sibling can be torn down), so it was copied.
type carryOverSourced struct {
	Path          string `json:"path"`
	Source        string `json:"source"`
	CopiedInstead bool   `json:"copiedInstead,omitempty"`
}

type carryOverReport struct {
	Applied         int                `json:"applied"`
	Failures        []carryOverFailure `json:"failures"`
	IncludeFailures []carryOverFailure `json:"includeFailures,omitempty"`
	Sourced         []carryOverSourced `json:"sourced,omitempty"`
}

const worktreeIncludeFile = ".worktreeinclude"

// --- .worktreeinclude resolution ---

func listOthersIgnored(projectPath, excludeArg string) ([]string, error) {
	stdout, err := runGit(projectPath,
		"ls-files", "-z", "--others", "--ignored", excludeArg, "--directory")
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(stdout, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths, nil
}

// gitPaths.ts makeIgnoreMatcher: leaf match, dir-form match, or any
// ancestor's fully-ignored directory entry.
func makeIgnoreMatcher(paths []string) func(string) bool {
	set := map[string]bool{}
	for _, p := range paths {
		set[p] = true
	}
	return func(relative string) bool {
		if relative == "" {
			return false
		}
		if set[relative] || set[relative+"/"] {
			return true
		}
		parts := strings.Split(relative, "/")
		for i := 1; i < len(parts); i++ {
			if set[strings.Join(parts[:i], "/")+"/"] {
				return true
			}
		}
		return false
	}
}

// Either separator, so a Windows-authored entry can't smuggle a ".."
// segment past the check.
var pathSepRe = regexp.MustCompile(`[\\/]`)

func isSafeRelPath(p string) bool {
	if strings.HasPrefix(p, "/") || strings.Contains(p, "\x00") {
		return false
	}
	for _, seg := range pathSepRe.Split(p, -1) {
		if seg == ".." {
			return false
		}
	}
	return true
}

// The integration is opt-out: absent means on.
func worktreeIncludeEnabled(config *projectConfig) bool {
	return config == nil || config.UseWorktreeInclude == nil || *config.UseWorktreeInclude
}

// Entries whose paths match a .worktreeinclude pattern AND are
// gitignored; always copy mode. Returns nil when the integration is
// off or the file is absent.
func resolveWorktreeInclude(projectPath string, config *projectConfig) ([]carryOverEntry, error) {
	if !worktreeIncludeEnabled(config) {
		return nil, nil
	}
	includePath := filepath.Join(projectPath, worktreeIncludeFile)
	if _, err := os.Lstat(includePath); err != nil {
		return nil, nil
	}
	candidates, err := listOthersIgnored(projectPath, "--exclude-from="+includePath)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	ignored, err := listOthersIgnored(projectPath, "--exclude-standard")
	if err != nil {
		return nil, err
	}
	isIgnored := makeIgnoreMatcher(ignored)
	var entries []carryOverEntry
	for _, candidate := range candidates {
		path := strings.TrimSuffix(candidate, "/")
		if path != "" && isIgnored(path) && isSafeRelPath(path) {
			entries = append(entries, carryOverEntry{Path: path, Mode: "copy"})
		}
	}
	return entries, nil
}

// Every checkout's own .worktreeinclude, resolved against that
// checkout's gitignore, unioned in source order: an entry that
// overlaps one already taken from an earlier source is dropped
// (mergeCarryOver's rule). Sources resolve in parallel (two ls-files
// walks each). A broken file in one checkout is reported and skipped,
// never fatal.
func resolveWorktreeIncludeAcross(sources []worktreeIdentity, config *projectConfig) ([]carryOverEntry, []carryOverFailure) {
	resolved := make([][]carryOverEntry, len(sources))
	errs := make([]error, len(sources))
	var wg sync.WaitGroup
	for i, source := range sources {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resolved[i], errs[i] = resolveWorktreeInclude(source.Path, config)
		}()
	}
	wg.Wait()

	var entries []carryOverEntry
	var failures []carryOverFailure
	for i, source := range sources {
		if errs[i] != nil {
			failure := carryOverFailure{Path: worktreeIncludeFile, Reason: errs[i].Error()}
			if !source.IsPrimary {
				failure.Source = source.Name
			}
			failures = append(failures, failure)
			continue
		}
		entries = mergeCarryOver(entries, resolved[i])
	}
	return entries, failures
}

// Collapse duplicate separators and trailing slashes before comparing
// stored entry paths against git output. Must stay in lockstep with
// normalizeRelPath in shared/gitPaths.ts.
func normalizeRelPath(p string) string {
	var parts []string
	for _, seg := range strings.Split(p, "/") {
		if seg != "" {
			parts = append(parts, seg)
		}
	}
	return strings.Join(parts, "/")
}

func pathsOverlap(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}

// Manual entries win over include entries that collide or overlap.
func mergeCarryOver(manual, include []carryOverEntry) []carryOverEntry {
	manualPaths := make([]string, len(manual))
	for i, e := range manual {
		manualPaths[i] = normalizeRelPath(e.Path)
	}
	merged := append([]carryOverEntry{}, manual...)
	for _, e := range include {
		overlaps := false
		for _, m := range manualPaths {
			if pathsOverlap(e.Path, m) {
				overlaps = true
				break
			}
		}
		if !overlaps {
			merged = append(merged, e)
		}
	}
	return merged
}

// --- sources ---

// Where entries are looked up, in order: the worktree holding the base
// branch (its gitignored files are the ones a branch-from of it
// expects), then the primary, then every other checkout by name. The
// destination itself is never a source. Mirrors the Configure picker,
// which unions the same checkouts so an entry can name a file the
// primary doesn't have.
func carryOverSources(proj project, destPath, base string) []worktreeIdentity {
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return []worktreeIdentity{{Name: "primary", Path: proj.Path, IsPrimary: true}}
	}
	baseBranch := ""
	if base != "" {
		// Same ref resolution a checkout uses: `origin/feat` lands on
		// local `feat` when it exists, which is the branch a worktree
		// would be holding.
		baseBranch, _ = resolveCheckoutRef(proj.Path, base, nil)
	}
	return orderCarryOverSources(identities, destPath, baseBranch)
}

func orderCarryOverSources(identities []worktreeIdentity, destPath, baseBranch string) []worktreeIdentity {
	rank := func(id worktreeIdentity) int {
		switch {
		case baseBranch != "" && !id.Detached && id.Branch == baseBranch:
			return 0
		case id.IsPrimary:
			return 1
		default:
			return 2
		}
	}
	var sources []worktreeIdentity
	for _, id := range identities {
		if id.Path != destPath {
			sources = append(sources, id)
		}
	}
	sort.SliceStable(sources, func(i, j int) bool {
		ri, rj := rank(sources[i]), rank(sources[j])
		if ri != rj {
			return ri < rj
		}
		return sources[i].Name < sources[j].Name
	})
	return sources
}

// First source that has the path, in lookup order.
func findCarryOverSource(sources []worktreeIdentity, relPath string) (worktreeIdentity, os.FileInfo, bool) {
	for _, source := range sources {
		if info, err := os.Stat(filepath.Join(source.Path, relPath)); err == nil {
			return source, info, true
		}
	}
	return worktreeIdentity{}, nil, false
}

// Whether some checkout currently has the entry.
func carryOverPathExists(proj project, relPath string) bool {
	_, _, ok := findCarryOverSource(carryOverSources(proj, "", ""), relPath)
	return ok
}

// --- application ---

func applyCarryOver(sources []worktreeIdentity, destPath string, entries []carryOverEntry) carryOverReport {
	report := carryOverReport{Failures: []carryOverFailure{}}
	if len(entries) == 0 {
		return report
	}
	var excludes []string
	for _, entry := range entries {
		failure, excludePath, source := applyOneCarryOver(sources, destPath, entry)
		sibling := source.Name != "" && !source.IsPrimary
		if failure != nil {
			if sibling {
				failure.Source = source.Name
			}
			report.Failures = append(report.Failures, *failure)
		} else if sibling {
			report.Sourced = append(report.Sourced, carryOverSourced{
				Path: entry.Path, Source: source.Name, CopiedInstead: entry.Mode == "symlink",
			})
		}
		if excludePath != "" {
			excludes = append(excludes, excludePath)
		}
	}
	report.Applied = len(entries) - len(report.Failures)
	appendExcludes(destPath, excludes)
	return report
}

// First source that has the entry wins. Returns the failure, the path
// to hide from git (directory symlinks only), and the source used
// (zero when none had the entry).
func applyOneCarryOver(sources []worktreeIdentity, destPath string, entry carryOverEntry) (failure *carryOverFailure, excludePath string, source worktreeIdentity) {
	source, srcInfo, ok := findCarryOverSource(sources, entry.Path)
	if !ok {
		return &carryOverFailure{Path: entry.Path, Reason: "Source missing in every checkout"}, "", source
	}
	src := filepath.Join(source.Path, entry.Path)
	dst := filepath.Join(destPath, entry.Path)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return &carryOverFailure{Path: entry.Path, Reason: err.Error()}, "", source
	}
	// Symlinks only ever target the primary: a sibling worktree can be
	// torn down, which would leave every link into it dangling. A
	// symlink entry found only in a sibling is copied instead.
	if entry.Mode == "symlink" && source.IsPrimary {
		// Absolute target so the link survives moving the worktree dir.
		if err := os.Symlink(src, dst); err != nil {
			if errors.Is(err, os.ErrExist) {
				return &carryOverFailure{Path: entry.Path, Reason: "Destination already exists"}, "", source
			}
			return &carryOverFailure{Path: entry.Path, Reason: err.Error()}, "", source
		}
		// Only directory symlinks are hidden from git (file symlinks
		// diff fine as 120000 patches).
		if srcInfo.IsDir() {
			return nil, entry.Path, source
		}
		return nil, "", source
	}
	// Copy mode, no overwrite of files git just laid down. cp -R is the
	// pragmatic stand-in for node's fs.cp(recursive, force:false):
	// -n refuses overwrites silently, so pre-check the destination to
	// report the same "already exists" failure the app does.
	if _, err := os.Lstat(dst); err == nil {
		return &carryOverFailure{Path: entry.Path, Reason: "Destination already exists"}, "", source
	}
	cmd := exec.Command("cp", "-R", "-P", src, dst)
	if output, err := cmd.CombinedOutput(); err != nil {
		reason := strings.TrimSpace(string(output))
		if reason == "" {
			reason = err.Error()
		}
		return &carryOverFailure{Path: entry.Path, Reason: reason}, "", source
	}
	return nil, "", source
}

// --- .git/info/exclude (exclude.ts parity) ---

var gitignoreMetaRe = regexp.MustCompile(`([*?[\]#!])`)

func escapeGitignorePattern(path string) string {
	s := strings.ReplaceAll(path, `\`, `\\`)
	s = gitignoreMetaRe.ReplaceAllString(s, `\$1`)
	// Trailing spaces are silently stripped by git; escape them.
	trimmed := strings.TrimRight(s, " ")
	s = trimmed + strings.Repeat(`\ `, len(s)-len(trimmed))
	return s
}

func appendExcludes(gitCwd string, paths []string) {
	if len(paths) == 0 {
		return
	}
	stdout, err := runGit(gitCwd, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return
	}
	excludeFile := strings.TrimSpace(stdout)
	if !filepath.IsAbs(excludeFile) {
		excludeFile = filepath.Join(gitCwd, excludeFile)
	}
	existingRaw, _ := os.ReadFile(excludeFile)
	existing := string(existingRaw)
	existingLines := map[string]bool{}
	for _, line := range strings.Split(existing, "\n") {
		existingLines[line] = true
	}
	var toAdd []string
	for _, p := range paths {
		line := "/" + escapeGitignorePattern(p)
		if !existingLines[line] {
			toAdd = append(toAdd, line)
		}
	}
	if len(toAdd) == 0 {
		return
	}
	if err := os.MkdirAll(filepath.Dir(excludeFile), 0o755); err != nil {
		return
	}
	leading := ""
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		leading = "\n"
	}
	// tmp + rename: this file lives in the USER's repo and may hold
	// their hand-written excludes.
	tmp := excludeFile + ".shigomori-tmp"
	content := existing + leading + strings.Join(toAdd, "\n") + "\n"
	if os.WriteFile(tmp, []byte(content), 0o644) == nil {
		_ = os.Rename(tmp, excludeFile)
	}
}
