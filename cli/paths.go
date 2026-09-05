package main

// Path math ported from shared/worktreeLayout.ts and
// host/lib/worktrees/paths.ts: path-derived worktree ids and the
// managed-layout bases. Must stay behavior-identical to the TS side --
// both compute the same ids and "is this managed?" answers over the
// same state.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// sha256(path)[:12], identical to worktreeIdFromPath in
// host/lib/git/worktrees.ts -- the same path must hash to the same id
// from the app and the CLI.
func worktreeIDFromPath(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])[:12]
}

// XDG config directory: $XDG_CONFIG_HOME, default ~/.config. Empty
// string when the home directory can't be resolved. Shared by the fish
// shell hook (cmd_shell.go) and the data dir pointer file (state.go).
func configHomeDir() string {
	if cfg := os.Getenv("XDG_CONFIG_HOME"); cfg != "" {
		return cfg
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config")
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

// expandHome's display-side inverse: long absolute paths read better
// as ~/... in menus. Never fed back into file operations.
func collapseHome(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if path == home {
		return "~"
	}
	if strings.HasPrefix(path, home+"/") {
		return "~" + path[len(home):]
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
	dirTrimmed := strings.TrimRight(dir, "/")
	return cwd == dirTrimmed || strings.HasPrefix(cwd, dirTrimmed+"/")
}

// Every base directory whose direct children count as "managed" for a
// project; all layouts included unconditionally (matches
// managedBasesFor in host/lib/worktrees/paths.ts).
func managedBasesFor(projectPath string, config *projectConfig) []string {
	bases := []string{
		filepath.Join(dataDir(), "worktrees", filepath.Base(projectPath)),
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
	folded := strings.TrimRight(worktreePath, "/")
	cut := strings.LastIndex(folded, "/")
	if cut < 0 {
		return false
	}
	parent := folded[:cut]
	for _, base := range bases {
		if parent == strings.TrimRight(base, "/") {
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
	return filepath.Join(dataDir(), "worktrees", filepath.Base(projectPath))
}

// Best-effort cleanup of the empty parent a worktree vacated; only
// touches directories shigomori owns (pruneEmptyManagedParents).
func pruneEmptyManagedParents(oldWorktreePath, projectPath string) {
	parent := filepath.Dir(oldWorktreePath)
	managedRootBase := filepath.Join(dataDir(), "worktrees", filepath.Base(projectPath))
	if parent == managedRootBase {
		_ = removeIfEmptyDir(parent)
		return
	}
	inProjectBase := filepath.Join(projectPath, ".shigomori", "worktrees")
	if parent == inProjectBase {
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
	pathSeparatorRe = regexp.MustCompile(`[/:]`)
	controlCharsRe  = regexp.MustCompile("[\x00-\x1f\x7f]")
	edgeTrimRe      = regexp.MustCompile(`^[.\s-]+|[.\s-]+$`)
)

func sanitizeBranchForPath(branch string) string {
	s := pathSeparatorRe.ReplaceAllString(branch, "-")
	s = controlCharsRe.ReplaceAllString(s, "")
	s = edgeTrimRe.ReplaceAllString(s, "")
	if s == "" || s == "." || s == ".." || isPrimaryKeyword(s) {
		return ""
	}
	return s
}

// The reserved worktree refs, mirroring RESERVED_NAMES in
// shared/branches.ts: `sm cd root` / `sm path primary` (and the
// qualified <project>/root, -p forms) address the project's primary
// checkout, unconditionally -- a worktree carrying one of these names
// never resolves by name, only by path or menu. sanitizeBranchForPath
// above rejects both words so create/adopt can't mint one; external
// tools still can, which is why the keyword can't be allowed to lose.
func isPrimaryKeyword(name string) bool {
	return strings.EqualFold(name, "root") || strings.EqualFold(name, "primary")
}

func isValidWorktreeDirName(name string) bool {
	return name != "" && sanitizeBranchForPath(name) == name
}
