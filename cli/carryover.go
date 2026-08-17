package main

// Carry-over, ported from main/lib/worktrees/{carryOver,
// worktreeInclude}.ts and main/lib/git/{branches,exclude}.ts: manual
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
	"strings"
)

type carryOverFailure struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type carryOverReport struct {
	Applied         int                `json:"applied"`
	Failures        []carryOverFailure `json:"failures"`
	IncludeFailures []carryOverFailure `json:"includeFailures,omitempty"`
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

func isSafeRelPath(p string) bool {
	if strings.HasPrefix(p, "/") || strings.Contains(p, "\x00") {
		return false
	}
	for _, seg := range regexp.MustCompile(`[\\/]`).Split(p, -1) {
		if seg == ".." {
			return false
		}
	}
	return true
}

// Entries whose paths match a .worktreeinclude pattern AND are
// gitignored; always copy mode. Returns nil when the integration is
// off or the file is absent.
func resolveWorktreeInclude(projectPath string, config *projectConfig) ([]carryOverEntry, error) {
	if config != nil && config.UseWorktreeInclude != nil && !*config.UseWorktreeInclude {
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

// --- application ---

func applyCarryOver(sourcePath, destPath string, entries []carryOverEntry) carryOverReport {
	report := carryOverReport{Failures: []carryOverFailure{}}
	if len(entries) == 0 {
		return report
	}
	var excludes []string
	for _, entry := range entries {
		failure, excludePath := applyOneCarryOver(sourcePath, destPath, entry)
		if failure != nil {
			report.Failures = append(report.Failures, *failure)
		}
		if excludePath != "" {
			excludes = append(excludes, excludePath)
		}
	}
	report.Applied = len(entries) - len(report.Failures)
	appendExcludes(destPath, excludes)
	return report
}

func applyOneCarryOver(sourcePath, destPath string, entry carryOverEntry) (*carryOverFailure, string) {
	src := filepath.Join(sourcePath, entry.Path)
	dst := filepath.Join(destPath, entry.Path)
	srcInfo, err := os.Stat(src)
	if err != nil {
		return &carryOverFailure{Path: entry.Path, Reason: "Source missing in main checkout"}, ""
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return &carryOverFailure{Path: entry.Path, Reason: err.Error()}, ""
	}
	if entry.Mode == "symlink" {
		// Absolute target so the link survives moving the worktree dir.
		if err := os.Symlink(src, dst); err != nil {
			if errors.Is(err, os.ErrExist) {
				return &carryOverFailure{Path: entry.Path, Reason: "Destination already exists"}, ""
			}
			return &carryOverFailure{Path: entry.Path, Reason: err.Error()}, ""
		}
		// Only directory symlinks are hidden from git (file symlinks
		// diff fine as 120000 patches).
		if srcInfo.IsDir() {
			return nil, entry.Path
		}
		return nil, ""
	}
	// Copy mode, no overwrite of files git just laid down. cp -R is the
	// pragmatic stand-in for node's fs.cp(recursive, force:false):
	// -n refuses overwrites silently, so pre-check the destination to
	// report the same "already exists" failure the app does.
	if _, err := os.Lstat(dst); err == nil {
		return &carryOverFailure{Path: entry.Path, Reason: "Destination already exists"}, ""
	}
	cmd := exec.Command("cp", "-R", "-P", src, dst)
	if output, err := cmd.CombinedOutput(); err != nil {
		reason := strings.TrimSpace(string(output))
		if reason == "" {
			reason = err.Error()
		}
		return &carryOverFailure{Path: entry.Path, Reason: reason}, ""
	}
	return nil, ""
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
