package main

// Path math: path-derived worktree ids and the managed-layout bases.
// The ids are an on-disk format (registry marks, per-worktree data
// files, dirty-capture refs are keyed by them), so the hash is fixed
// for good. The app's worktreeIdFromPath computes the same id (an app
// proof pins it against this function's output), and
// shared/git/worktreeLayout.ts mirrors the layout bases for display
// only; destinations come from `sm worktrees destination`.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// sha256(path)[:12], identical to the app's worktreeIdFromPath. The
// same path must hash to the same id from the app and the CLI.
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

// True when the process's cwd is dir or sits anywhere below it, the
// "your shell is inside the directory being removed" check.
func cwdInside(dir string) bool {
	cwd, err := os.Getwd()
	if err != nil {
		return false
	}
	dirTrimmed := strings.TrimRight(dir, "/")
	return cwd == dirTrimmed || strings.HasPrefix(cwd, dirTrimmed+"/")
}

// The external drive a path sits on: /Volumes/<name> for anything below
// a mounted volume, "" otherwise. Path math on purpose, with no stat,
// so shared/git/worktreeLayout.ts can mirror it. macOS mounts every
// drive but the boot one there, and the app ships for macOS alone.
func externalVolumeRoot(path string) string {
	const mounts = "/Volumes/"
	if !strings.HasPrefix(path, mounts) {
		return ""
	}
	rest := path[len(mounts):]
	cut := strings.Index(rest, "/")
	if cut <= 0 || strings.Trim(rest[cut:], "/") == "" {
		return ""
	}
	return mounts + rest[:cut]
}

// The managed root's shape on the project's own external drive:
// <volume>/<dataDirName>/worktrees/<project>, under the flavor's own
// folder name wherever the data dir itself happens to be. "" when the
// project isn't on an external drive. Always managed (managedBasesFor),
// so worktrees placed there stay ours whatever happens to the setting
// or the data dir later.
func driveBaseOf(projectPath string) string {
	volume := externalVolumeRoot(projectPath)
	if volume == "" {
		return ""
	}
	return filepath.Join(volume, dataDirName, "worktrees", filepath.Base(projectPath))
}

// driveBaseOf as a destination for new worktrees: "" as well when the
// data dir sits on the project's drive, where the managed root already
// is.
func projectDriveBase(projectPath string) string {
	if volume := externalVolumeRoot(projectPath); volume != "" && strings.HasPrefix(dataDir(), volume+"/") {
		return ""
	}
	return driveBaseOf(projectPath)
}

func managedOnProjectDriveEnabled(global globalConfig) bool {
	return global.ManagedOnProjectDrive != nil && *global.ManagedOnProjectDrive
}

// Every base directory whose direct children count as "managed" for a
// project; all layouts included unconditionally, so switching layouts
// doesn't turn existing worktrees external.
func managedBasesFor(projectPath string, config *projectConfig) []string {
	bases := []string{
		filepath.Join(dataDir(), "worktrees", filepath.Base(projectPath)),
		filepath.Join(projectPath, ".shigomori", "worktrees"),
	}
	if driveBase := driveBaseOf(projectPath); driveBase != "" {
		bases = append(bases, driveBase)
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

// Where new worktrees go for this project. Custom without a path falls
// back to the managed root, and the device's managedOnProjectDrive
// setting moves the managed root onto the project's external drive
// when it is on one.
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
	case "managed-root":
		// The setting is read only for a project that has a drive to use.
		if driveBase := projectDriveBase(projectPath); driveBase != "" &&
			managedOnProjectDriveEnabled(readGlobalConfigHints()) {
			return driveBase
		}
	}
	return filepath.Join(dataDir(), "worktrees", filepath.Base(projectPath))
}

// Best-effort cleanup of the empty parent a worktree vacated; only
// touches directories shigomori owns (pruneEmptyManagedParents).
func pruneEmptyManagedParents(oldWorktreePath, projectPath string) {
	parent := filepath.Dir(oldWorktreePath)
	switch parent {
	case filepath.Join(dataDir(), "worktrees", filepath.Base(projectPath)):
		removeEmptyDirs(parent, 1)
	case filepath.Join(projectPath, ".shigomori", "worktrees"):
		removeEmptyDirs(parent, 2)
	case driveBaseOf(projectPath):
		// <volume>/<dataDirName>/worktrees/<project>: the folder on the
		// project's drive goes whole once the last project leaves it,
		// so nothing of ours stays behind on the drive.
		removeEmptyDirs(parent, 3)
	}
}

// Removes dir and up to levels-1 of its parents, stopping at the first
// one that isn't empty. os.Remove on a directory fails unless empty,
// exactly like rmdir.
func removeEmptyDirs(dir string, levels int) {
	for range levels {
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

// --- worktree dir name validation (shared/git/branches.ts port) ---

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
// shared/git/branches.ts: `sm cd root` / `sm path primary` (and the
// qualified <project>/root, -p forms) address the project's primary
// checkout, unconditionally. A worktree carrying one of these names
// never resolves by name, only by path or menu. sanitizeBranchForPath
// above rejects both words so create/adopt can't mint one; external
// tools still can, which is why the keyword can't be allowed to lose.
func isPrimaryKeyword(name string) bool {
	return strings.EqualFold(name, "root") || strings.EqualFold(name, "primary")
}

func isValidWorktreeDirName(name string) bool {
	return name != "" && sanitizeBranchForPath(name) == name
}
