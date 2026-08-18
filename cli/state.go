package main

// On-disk state access, ported from main/lib/config/{store,global,
// project}.ts and main/lib/util/{jsonFile,lockFile}.ts. Layout under
// the root:
//   state.json                              runtime data (projects, shelved)
//   config.json                             global prefs
//   projects/<projectId>/project.json       per-project config
//   projects/<projectId>/worktrees/<id>.json  per-worktree data
//   updater.json / updater-request.json     `sm update` bridge (cmd_update.go)
//   updates/                                staged app updates (updater.go)
// Writes are atomic tmp+rename; the state.json read-modify-write holds
// the same `<file>.lock` advisory lock the app takes, so the two
// processes can't clobber each other.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var cachedRoot string

func initRoot() {
	if envRoot := os.Getenv("SHIGOMORI_ROOT"); envRoot != "" {
		cachedRoot = toAbsolute(envRoot)
		return
	}
	if pointed := readRootPointer(); pointed != "" {
		cachedRoot = pointed
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	cachedRoot = filepath.Join(home, rootDirName)
}

// The root pointer file relocates the state root without an env var:
// $XDG_CONFIG_HOME/<rootDirName>/root, one line holding an absolute
// path (~/ allowed). Go mirror of the policy in shared/cliDist.mts
// (the app reads and writes the same file). SHIGOMORI_ROOT still beats
// it, and the app pins that var on every delegated spawn. Missing,
// empty, or non-absolute content falls through to the flavor default
// -- initRoot runs before every command, so a malformed file must not
// be fatal.
func readRootPointer() string {
	cfg := configHomeDir()
	if cfg == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(cfg, rootDirName, "root"))
	if err != nil {
		return ""
	}
	target := expandHome(strings.TrimSpace(string(data)))
	if target == "" || !filepath.IsAbs(target) {
		return ""
	}
	if !looksLikeRootTarget(target) {
		return ""
	}
	return target
}

// Guard on what a hand-edited pointer may aim the root at: a directory
// that doesn't exist yet, is empty, or already holds shigomori state.
// A pointer at ~/Documents must fall back to the default rather than
// adopt a directory full of unrelated files as the state root. Mirror
// of main/lib/util/paths.ts looksLikeRootTarget -- keep in sync.
func looksLikeRootTarget(target string) bool {
	entries, err := os.ReadDir(target)
	if err != nil {
		// Nonexistent is fine (created on first write). A file or an
		// unreadable path is not a usable root.
		return errors.Is(err, os.ErrNotExist)
	}
	if len(entries) == 0 {
		return true
	}
	for _, entry := range entries {
		if entry.Name() == "state.json" || entry.Name() == "config.json" {
			return true
		}
	}
	return false
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

// --- schema marker ---

// The version of the on-disk shape this build writes. Every file
// shigomori persists carries it: state.json, config.json,
// projects/<id>/project.json and projects/<id>/worktrees/<id>.json.
// Nothing reads it to decide anything yet. It exists so a later format
// change can tell an old file from a new one instead of inferring the
// shape from whichever keys happen to be present. The app stamps the
// same key with the same value (main/lib/util/jsonFile.ts). The two
// writers have to move together, since a marker the two disagree on is
// worse than no marker at all.
const schemaVersion = 1

// Pre-encoded for the state.json map, whose values are already-encoded
// JSON.
var schemaVersionRaw = json.RawMessage(strconv.Itoa(schemaVersion))

// Always this build's constant, never whatever the file happened to
// carry. A writer that copied a higher number forward would be
// claiming a shape it has never produced, and the whole-document
// `config write --data` path doesn't have the old value in hand
// anyway, so copying it forward isn't a rule both writers could
// follow. Callers stamp only once a write is actually going to happen,
// so a no-op mutation stays a no-op.
func stampSchemaVersion(doc map[string]any) {
	doc["schemaVersion"] = schemaVersion
}

var notedNewerSchema = map[string]bool{}

// The read side is deliberately toothless. Files written before the
// marker existed have none, which is normal and forever, and a file
// from a newer build is read exactly as it always was: refusing would
// strand anyone who ran a newer build once, over a field nothing
// consumes. It is still worth one line on stderr, because this build's
// next write stamps the file back down to schemaVersion and nothing
// else would ever mention that. Mirrors noteNewerSchema in the app's
// jsonFile.ts.
func noteNewerSchema(path string, raw []byte) {
	var doc struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.SchemaVersion <= schemaVersion {
		return
	}
	if notedNewerSchema[path] {
		return
	}
	notedNewerSchema[path] = true
	note(yellowErr(fmt.Sprintf(
		"%s was written by a newer build (schemaVersion %d, this build writes %d). Reading it anyway.",
		path, doc.SchemaVersion, schemaVersion)))
}

func statePath() string { return filepath.Join(shigomoriRoot(), "state.json") }

// Only a genuinely absent file reads as empty. updateStateKey rewrites
// the whole file from what this returns, so a permission error, an IO
// error or a cloud file that hasn't been materialized read as {} would
// replace the project registry, the shelf and every use log with the
// one key being written. Malformed content is refused for the same
// reason: it is the case where a blind rewrite destroys something the
// user could still repair. Mirrors readAll in the app's store.ts.
func readStateFile() (map[string]json.RawMessage, error) {
	path := statePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]json.RawMessage{}, nil
		}
		return nil, errf("Couldn't read %s: %v", path, err)
	}
	noteNewerSchema(path, raw)
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return nil, errf("%s is not valid JSON (%v). Fix the file or move it aside, then retry.", path, err)
	}
	if all == nil {
		return nil, errf("%s is not a JSON object. Fix the file or move it aside, then retry.", path)
	}
	return all, nil
}

// Read of the display-only hints (shelf flags, launcher use counts).
// Every command loads the projects list from this same file before it
// dispatches, so a failure this late means the file went unreadable
// mid-command: drop the hint rather than abort work that is otherwise
// fine. No writer goes through here -- updateStateKey refuses instead.
func readStateHints() map[string]json.RawMessage {
	all, err := readStateFile()
	if err != nil {
		vlog("[state] %v", err)
		return map[string]json.RawMessage{}
	}
	return all
}

func loadProjects() ([]project, error) {
	all, err := readStateFile()
	if err != nil {
		return nil, err
	}
	var projects []project
	if raw, ok := all["projects"]; ok {
		_ = json.Unmarshal(raw, &projects)
	}
	return projects, nil
}

func readShelvedSet() map[string]bool {
	shelved := map[string]bool{}
	if raw, ok := readStateHints()["shelvedWorktrees"]; ok {
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
		all, err := readStateFile()
		if err != nil {
			return err
		}
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
		// stampSchemaVersion's state.json flavor: this map's values are
		// already encoded, so the marker goes in encoded too.
		all["schemaVersion"] = schemaVersionRaw
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
	path := configJSONPath()
	raw, err := os.ReadFile(path)
	if err == nil {
		noteNewerSchema(path, raw)
		_ = json.Unmarshal(raw, &cfg)
	}
	return cfg
}

// nil when the file is missing, unreadable, or fails the schema's
// required-field check -- matching the app's null-on-invalid behavior.
func readProjectConfig(projectID string) *projectConfig {
	path := projectConfigJSONPath(projectID)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	noteNewerSchema(path, raw)
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
