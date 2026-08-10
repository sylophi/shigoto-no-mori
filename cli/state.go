package main

// On-disk state access, ported from main/lib/config/{store,global,
// project}.ts and main/lib/util/{jsonFile,lockFile}.ts. Layout under
// the root:
//   state.json                              runtime data (projects, shelved)
//   config.json                             global prefs
//   projects/<projectId>/project.json       per-project config
//   projects/<projectId>/worktrees/<id>.json  per-worktree data
//   updater.json / updater-request.json     `sm update` bridge (cmd_update.go)
// Writes are atomic tmp+rename; the state.json read-modify-write holds
// the same `<file>.lock` advisory lock the app takes, so the two
// processes can't clobber each other.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var cachedRoot string

func initRoot() {
	if envRoot := os.Getenv("SHIGOMORI_ROOT"); envRoot != "" {
		cachedRoot = toAbsolute(envRoot)
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	cachedRoot = filepath.Join(home, rootDirName)
}

func shigomoriRoot() string {
	if cachedRoot == "" {
		panic("shigomori root not initialized")
	}
	return cachedRoot
}

type project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// Per-project config (ShigomoriConfigSchema). Mirrors the zod schema's
// strictness where it matters: defaultBranch is required there, so a
// config missing it is treated as absent entirely -- same as the app's
// readShigomoriConfig(...).catch(() => null).
type projectConfig struct {
	Scripts struct {
		Setup    string `json:"setup"`
		Teardown string `json:"teardown"`
	} `json:"scripts"`
	DefaultBranch      string            `json:"defaultBranch"`
	LastMergeMethod    string            `json:"lastMergeMethod"`
	CarryOver          []carryOverEntry  `json:"carryOver"`
	UseWorktreeInclude *bool             `json:"useWorktreeInclude"`
	WorktreeLayout     string            `json:"worktreeLayout"`
	CustomWorktreePath string            `json:"customWorktreePath"`
	Launchers          []launcherCommand `json:"launchers"`
}

type carryOverEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"` // "symlink" | "copy"
}

type globalConfig struct {
	DeleteBranchOnRemove *bool             `json:"deleteBranchOnRemove"`
	PortPool             *bool             `json:"portPool"`
	AutoPopulateInstall  *bool             `json:"autoPopulateInstall"`
	Launchers            []launcherCommand `json:"launchers"`
	HiddenLaunchers      []string          `json:"hiddenLaunchers"`
}

type launcherCommand struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Command string `json:"command"`
}

func statePath() string { return filepath.Join(shigomoriRoot(), "state.json") }

func readStateFile() map[string]json.RawMessage {
	raw, err := os.ReadFile(statePath())
	if err != nil {
		return map[string]json.RawMessage{}
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(raw, &all) != nil {
		return map[string]json.RawMessage{}
	}
	return all
}

func loadProjects() []project {
	var projects []project
	if raw, ok := readStateFile()["projects"]; ok {
		_ = json.Unmarshal(raw, &projects)
	}
	return projects
}

func readShelvedSet() map[string]bool {
	shelved := map[string]bool{}
	if raw, ok := readStateFile()["shelvedWorktrees"]; ok {
		var m map[string]bool
		if json.Unmarshal(raw, &m) == nil {
			for id, v := range m {
				if v {
					shelved[id] = true
				}
			}
		}
	}
	return shelved
}

// updateStateKey mirrors store.ts updateKey: read-modify-write of one
// state.json key with the read under the cross-process lock, so a
// concurrent app write can't be clobbered. fn receives the key's raw
// current value (nil when absent) and returns the value to store;
// returning nil skips the write (no-op detected under the lock).
func updateStateKey(key string, fn func(raw json.RawMessage) (any, error)) error {
	return withStateLock(func() error {
		all := readStateFile()
		next, err := fn(all[key])
		if err != nil {
			return err
		}
		if next == nil {
			return nil
		}
		encoded, err := json.Marshal(next)
		if err != nil {
			return err
		}
		all[key] = encoded
		return atomicWriteJSON(statePath(), all)
	})
}

// Flips the id in the shelved map (store.ts writeKey semantics).
func setShelved(worktreeID string, shelved bool) error {
	return updateStateKey("shelvedWorktrees", func(raw json.RawMessage) (any, error) {
		m := map[string]bool{}
		if raw != nil {
			_ = json.Unmarshal(raw, &m)
		}
		if m[worktreeID] == shelved {
			return nil, nil
		}
		if shelved {
			m[worktreeID] = true
		} else {
			delete(m, worktreeID)
		}
		return m, nil
	})
}

func dropShelved(worktreeID string) error {
	return setShelved(worktreeID, false)
}

func readGlobalConfig() globalConfig {
	var cfg globalConfig
	raw, err := os.ReadFile(filepath.Join(shigomoriRoot(), "config.json"))
	if err == nil {
		_ = json.Unmarshal(raw, &cfg)
	}
	return cfg
}

// nil when the file is missing, unreadable, or fails the schema's
// required-field check -- matching the app's null-on-invalid behavior.
func readProjectConfig(projectID string) *projectConfig {
	raw, err := os.ReadFile(filepath.Join(shigomoriRoot(), "projects", projectID, "project.json"))
	if err != nil {
		return nil
	}
	var cfg projectConfig
	if json.Unmarshal(raw, &cfg) != nil {
		return nil
	}
	if strings.TrimSpace(cfg.DefaultBranch) == "" {
		return nil
	}
	return &cfg
}

func deleteWorktreeData(projectID, worktreeID string) {
	path := filepath.Join(shigomoriRoot(), "projects", projectID, "worktrees", worktreeID+".json")
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		vlog("[state] delete worktree data: %v", err)
	}
}

var tempCounter int

func atomicWriteJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d.%d.%d", path, os.Getpid(), time.Now().UnixMilli(), tempCounter)
	tempCounter++
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// --- cross-process file locks (main/lib/util/lockFile.ts protocol) ---

const (
	lockStale   = 10 * time.Second
	lockTimeout = 5 * time.Second
	lockRetry   = 25 * time.Millisecond
)

func withStateLock(fn func() error) error {
	return withFileLock(statePath(), fn)
}

// Guards a read-modify-write of `path` against the app doing the same:
// both sides take the sibling `<path>.lock` before touching the file.
func withFileLock(path string, fn func() error) error {
	lockPath := path + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return err
	}
	deadline := time.Now().Add(lockTimeout)
	for {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d", os.Getpid())
			f.Close()
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		// Break a leaked lock (holder crashed between create and
		// unlink). Best effort: the stat can race a concurrent release
		// and the removal can fail; fall through to the deadline check
		// either way so an undeletable lock can't spin forever.
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > lockStale {
			_ = os.Remove(lockPath)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for file lock: %s", lockPath)
		}
		time.Sleep(lockRetry)
	}
	defer os.Remove(lockPath)
	return fn()
}
