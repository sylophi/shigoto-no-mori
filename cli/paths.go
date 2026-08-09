package main

// Path math ported from shared/worktreeLayout.ts and
// main/lib/worktrees/paths.ts: comparable form for equality checks,
// path-derived worktree ids, and the managed-layout bases. Must stay
// behavior-identical to the TS side -- both compute the same ids and
// "is this managed?" answers over the same state.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	windowsDrivePrefix = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
	uncPrefix          = regexp.MustCompile(`^[\\/]{2}`)
)

func isWindowsStyle(path string) bool {
	return windowsDrivePrefix.MatchString(path) || uncPrefix.MatchString(path)
}

// Keyed off the path's own shape, not the host OS, matching
// shared/worktreeLayout.ts comparablePath.
func comparablePath(path string) string {
	if !isWindowsStyle(path) {
		return path
	}
	return strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
}

// sha256(comparablePath)[:12], identical to worktreeIdFromPath in
// main/lib/git/worktrees.ts -- the same path must hash to the same id
// from the app and the CLI.
func worktreeIDFromPath(path string) string {
	sum := sha256.Sum256([]byte(comparablePath(path)))
	return hex.EncodeToString(sum[:])[:12]
}

func expandHome(path string) string {
	if path == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

func toAbsolute(path string) string {
	expanded := expandHome(path)
	if filepath.IsAbs(expanded) {
		return expanded
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return expanded
	}
	return abs
}

// True when the process's cwd is dir or sits anywhere below it --
// the "your shell is inside the directory being removed" check.
func cwdInside(dir string) bool {
	cwd, err := os.Getwd()
	if err != nil {
		return false
	}
	cwdC := comparablePath(cwd)
	dirC := strings.TrimRight(comparablePath(dir), "/")
	return cwdC == dirC || strings.HasPrefix(cwdC, dirC+"/")
}

// Every base directory whose direct children count as "managed" for a
// project; all layouts included unconditionally (matches
// managedBasesFor in main/lib/worktrees/paths.ts).
func managedBasesFor(projectPath string, config *projectConfig) []string {
	bases := []string{
		filepath.Join(shigomoriRoot(), "worktrees", filepath.Base(projectPath)),
		filepath.Join(projectPath, ".shigomori", "worktrees"),
	}
	if config != nil {
		custom := strings.TrimSpace(config.CustomWorktreePath)
		if custom != "" {
			bases = append(bases, strings.TrimRight(custom, "/"))
		}
	}
	return bases
}

// Parent equality, not prefix matching (a root base would otherwise
// claim every worktree on the volume); matches isManagedPath.
func isManagedPath(worktreePath string, bases []string) bool {
	folded := strings.TrimRight(comparablePath(worktreePath), "/")
	cut := strings.LastIndex(folded, "/")
	if cut < 0 {
		return false
	}
	parent := folded[:cut]
	for _, base := range bases {
		if parent == strings.TrimRight(comparablePath(base), "/") {
			return true
		}
	}
	return false
}

// Where new worktrees go for this project (worktreeBaseFor +
// resolveWorktreeBase in TS). Custom without a path falls back to the
// managed root.
func resolveWorktreeBase(projectPath string, config *projectConfig) string {
	layout := "managed-root"
	if config != nil && config.WorktreeLayout != "" {
		layout = config.WorktreeLayout
	}
	switch layout {
	case "in-project":
		return filepath.Join(projectPath, ".shigomori", "worktrees")
	case "custom":
		if config != nil {
			custom := strings.TrimSpace(config.CustomWorktreePath)
			if custom != "" {
				return strings.TrimRight(custom, "/")
			}
		}
	}
	return filepath.Join(shigomoriRoot(), "worktrees", filepath.Base(projectPath))
}

// Best-effort cleanup of the empty parent a worktree vacated; only
// touches directories shigomori owns (pruneEmptyManagedParents).
func pruneEmptyManagedParents(oldWorktreePath, projectPath string) {
	parent := filepath.Dir(oldWorktreePath)
	managedRootBase := filepath.Join(shigomoriRoot(), "worktrees", filepath.Base(projectPath))
	if comparablePath(parent) == comparablePath(managedRootBase) {
		_ = removeIfEmptyDir(parent)
		return
	}
	inProjectBase := filepath.Join(projectPath, ".shigomori", "worktrees")
	if comparablePath(parent) == comparablePath(inProjectBase) {
		if removeIfEmptyDir(parent) == nil {
			_ = removeIfEmptyDir(filepath.Dir(parent))
		}
	}
}

func removeIfEmptyDir(path string) error {
	// os.Remove on a directory fails unless empty -- exactly rmdir.
	return os.Remove(path)
}

// --- worktree dir name validation (shared/branches.ts port) ---

var (
	pathSeparatorRe = regexp.MustCompile(`[\\/]`)
	ntfsIllegalRe   = regexp.MustCompile(`[<>:"|?*]`)
	controlCharsRe  = regexp.MustCompile("[\x00-\x1f\x7f]")
	edgeTrimRe      = regexp.MustCompile(`^[.\s-]+|[.\s-]+$`)
	dosDeviceRe     = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)`)
)

func sanitizeBranchForPath(branch string) string {
	s := pathSeparatorRe.ReplaceAllString(branch, "-")
	s = ntfsIllegalRe.ReplaceAllString(s, "-")
	s = controlCharsRe.ReplaceAllString(s, "")
	s = edgeTrimRe.ReplaceAllString(s, "")
	if s == "" || s == "." || s == ".." {
		return ""
	}
	if dosDeviceRe.MatchString(s) {
		return ""
	}
	return s
}

func isValidWorktreeDirName(name string) bool {
	return name != "" && sanitizeBranchForPath(name) == name
}
