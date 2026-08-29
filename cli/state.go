package main

// On-disk state access, ported from host/lib/config/{store,global,
// project}.ts and host/lib/util/{jsonFile,lockFile}.ts. Layout under
// the root:
//   registry.json                           projects, shelved worktrees
//   state.json                              use logs, sort/collapse prefs
//   config.json                             global prefs
//   projects/<projectId>/project.json       per-project config
//   projects/<projectId>/worktrees/<id>.json  per-worktree data
//   updater.json / updater-request.json     `sm update` bridge (cmd_update.go)
//   updates/                                staged app updates (updater.go)
// Writes are atomic tmp+rename; each read-modify-write holds the same
// `<file>.lock` advisory lock the app takes, so the two processes can't
// clobber each other.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
// it, and nothing injects that var -- a caller who sets it is
// sandboxing the whole tree on purpose (scripts.go). Missing,
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
// of host/lib/util/paths.ts looksLikeRootTarget -- keep in sync.
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
		if entry.Name() == "registry.json" || entry.Name() == "state.json" ||
			entry.Name() == "config.json" {
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
	// "terrier" on entries merged from the terrier registry
	// (terrier.go). Never persisted: registry.json rows always leave it
	// empty, and the merge layer decorates at read time -- mirroring
	// ProjectSchema's source field (shared/schemas/project.ts).
	Source string `json:"source,omitempty"`
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
	Terrier              *bool             `json:"terrier"`
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
// shigomori persists carries it: state.json, registry.json,
// config.json, projects/<id>/project.json and
// projects/<id>/worktrees/<id>.json. Nothing reads it to decide
// anything yet. It exists so a later format change can tell an old
// file from a new one instead of inferring the shape from whichever
// keys happen to be present. The app stamps the
// same key with the same value (host/lib/util/jsonFile.ts). The two
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

// Guarded: commands that fan out read several state files at once, and
// two of them noticing something on the same run must not race.
var (
	notedMu          sync.Mutex
	notedNewerSchema = map[string]bool{}
)

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
	notedMu.Lock()
	seen := notedNewerSchema[path]
	notedNewerSchema[path] = true
	notedMu.Unlock()
	if seen {
		return
	}
	note(yellowErr(fmt.Sprintf(
		"%s was written by a newer build (schemaVersion %d, this build writes %d). Reading it anyway.",
		path, doc.SchemaVersion, schemaVersion)))
}

// The registry's two keys. The app names the same two in
// host/lib/config/store.ts.
const (
	projectsKey = "projects"
	shelvedKey  = "shelvedWorktrees"
)

// deviceId (app-written, host/lib/config/deviceId.ts) is deliberately
// absent: this list drives only the state.json→registry.json split,
// which deviceId postdates.
var registryKeys = []string{projectsKey, shelvedKey}

// Every path under the state root in one place, so a layout change never
// has to be chased into the command files.
func statePath() string { return filepath.Join(shigomoriRoot(), "state.json") }

func registryPath() string { return filepath.Join(shigomoriRoot(), "registry.json") }

func configJSONPath() string { return filepath.Join(shigomoriRoot(), "config.json") }

func projectDataDir(projectID string) string {
	return filepath.Join(shigomoriRoot(), "projects", projectID)
}

func projectConfigJSONPath(projectID string) string {
	return filepath.Join(projectDataDir(projectID), "project.json")
}

func worktreeDataPath(projectID, worktreeID string) string {
	return filepath.Join(projectDataDir(projectID), "worktrees", worktreeID+".json")
}

// One read-and-classify for every JSON document the CLI reads
// strictly: only a genuinely absent file reads as empty (found=false,
// decode never runs). An unreadable or malformed file is an error.
// Both error strings live here and nowhere else.
func readJSONDoc(path string, decode func([]byte) error) (found bool, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, errf("Couldn't read %s: %v", path, err)
	}
	noteNewerSchema(path, raw)
	if err := decode(raw); err != nil {
		// A wrong-typed field is not a syntax problem. Telling the user
		// to fix JSON that parses fine sends them hunting for a comma
		// that isn't there.
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return true, errf("%s has a wrong-typed %q value (%v). Fix the file or move it aside, then retry.", path, typeErr.Field, err)
		}
		return true, errf("%s is not valid JSON (%v). Fix the file or move it aside, then retry.", path, err)
	}
	return true, nil
}

// Only a genuinely absent file reads as empty. updateFileKey rewrites
// the whole file from what this returns, so a permission error, an IO
// error or a cloud file that hasn't been materialized read as {} would
// replace the project registry, the shelf or every use log with the
// one key being written. Malformed content is refused for the same
// reason: it is the case where a blind rewrite destroys something the
// user could still repair. Mirrors readAll in the app's store.ts.
func readJSONObject(path string) (map[string]json.RawMessage, error) {
	var all map[string]json.RawMessage
	found, err := readJSONDoc(path, func(raw []byte) error {
		return json.Unmarshal(raw, &all)
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return map[string]json.RawMessage{}, nil
	}
	if all == nil {
		return nil, errf("%s is not a JSON object. Fix the file or move it aside, then retry.", path)
	}
	return all, nil
}

// The write side of readJSONObject, and the only place the schema
// marker is stamped on these two documents. The map's values are
// already-encoded JSON, so the marker goes in encoded too.
func writeJSONObject(path string, doc map[string]json.RawMessage) error {
	doc["schemaVersion"] = schemaVersionRaw
	return atomicWriteJSON(path, doc)
}

func readStateFile() (map[string]json.RawMessage, error) {
	return readJSONObject(statePath())
}

// Drains an old-format root before the first read, so no caller has to
// know the split happened.
func readRegistryFile() (map[string]json.RawMessage, error) {
	if err := ensureRegistrySplit(); err != nil {
		return nil, err
	}
	return readJSONObject(registryPath())
}

// A file this build could not read, said once per process. Nothing
// else reads state.json before a command dispatches (the pre-dispatch
// load reads registry.json), so without this a truncated state.json
// would refuse every use-log write for as long as it stays broken and
// never say a word about it. The hint readers and the use-log writers
// hit the same file several times per command, hence the dedupe: one
// warning points at the cause, ten bury the output it came with.
// Shaped like noteNewerSchema above, which dedupes the same way.
var notedFileTrouble = map[string]bool{}

func noteFileTrouble(path, degraded string, err error) {
	notedMu.Lock()
	seen := notedFileTrouble[path]
	notedFileTrouble[path] = true
	notedMu.Unlock()
	if seen {
		return
	}
	note(yellowErr("warning:") + " " + err.Error())
	note(dimErr(degraded))
}

// state.json holds use counts and view preferences, so a command whose
// real work lives elsewhere still runs. updateFileKey refuses the
// write, which is #161's guarantee and stays.
func noteStateTrouble(err error) {
	noteFileTrouble(statePath(),
		"Use counts and view preferences are unavailable, and new uses aren't recorded, until the file is fixed.",
		err)
}

func noteRegistryTrouble(err error) {
	noteFileTrouble(registryPath(),
		"Shelved worktrees are listed as unshelved until the file is fixed.",
		err)
}

// Reads of the display-only hints: use counts and view preferences in
// state.json, shelf flags in registry.json. Losing one costs a sort
// order or a badge, so the command carries on with an empty document
// rather than aborting work that is otherwise fine. No writer goes
// through here. updateFileKey refuses on a bad read instead.
func readStateHints() map[string]json.RawMessage {
	all, err := readStateFile()
	if err != nil {
		noteStateTrouble(err)
		return map[string]json.RawMessage{}
	}
	return all
}

func readRegistryHints() map[string]json.RawMessage {
	all, err := readRegistryFile()
	if err != nil {
		noteRegistryTrouble(err)
		return map[string]json.RawMessage{}
	}
	return all
}

// readJSONObject's strictness has to reach the key values too: a
// well-formed document holding a wrong-shaped value would otherwise
// read as empty, and the next locked write would persist that
// emptiness -- the "rebuilt from an empty picture" failure the strict
// document read exists to prevent, one level down.
func malformedKeyErr(path, key string, err error) error {
	return errf("%s holds a malformed %q value (%v). Fix the file or move it aside, then retry.", path, key, err)
}

// The one way to read a key's value: nil raw reads as absent, anything
// else must decode. Every consumer -- reader or locked read-modify-
// write -- goes through here so no call site can quietly fall back to
// empty.
func decodeKey[T any](path, key string, raw json.RawMessage, dst *T) error {
	if raw == nil {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return malformedKeyErr(path, key, err)
	}
	return nil
}

func loadProjects() ([]project, error) {
	all, err := readRegistryFile()
	if err != nil {
		return nil, err
	}
	var projects []project
	if err := decodeKey(registryPath(), projectsKey, all[projectsKey], &projects); err != nil {
		return nil, err
	}
	return projects, nil
}

func readShelvedSet() map[string]bool {
	shelved := map[string]bool{}
	var m map[string]bool
	if err := decodeKey(registryPath(), shelvedKey, readRegistryHints()[shelvedKey], &m); err != nil {
		noteRegistryTrouble(err)
		return shelved
	}
	for id, v := range m {
		if v {
			shelved[id] = true
		}
	}
	return shelved
}

// updateFileKey mirrors store.ts updateKey: read-modify-write of one
// key with the read under the cross-process lock, so a concurrent app
// write can't be clobbered. fn receives the key's raw current value
// (nil when absent) and returns the value to store; returning nil skips
// the write (no-op detected under the lock).
func updateFileKey(path, key string, fn func(raw json.RawMessage) (any, error)) error {
	return withFileLock(path, func() error {
		all, err := readJSONObject(path)
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
		return writeJSONObject(path, all)
	})
}

func updateStateKey(key string, fn func(raw json.RawMessage) (any, error)) error {
	return updateFileKey(statePath(), key, fn)
}

func updateRegistryKey(key string, fn func(raw json.RawMessage) (any, error)) error {
	if err := ensureRegistrySplit(); err != nil {
		return err
	}
	return updateFileKey(registryPath(), key, fn)
}

// --- one-time move of the registry keys out of state.json ---
//
// Roots written by an earlier build keep the project list and the shelf
// in state.json. The first registry access in each process drains them
// into registry.json. Mirrors ensureRegistrySplit in the app's
// store.ts, which has to agree with this down to the file name and the
// key names.
//
// The write order is the whole safety argument. registry.json is
// written first and state.json is stripped second, both atomic
// renames, so a crash between them leaves the data in two places
// rather than in none. A key present in registry.json always wins:
// that file is the live copy the moment it exists.
//
// That is also why the check below is a stat and not a read. Once
// registry.json is there, reads are already correct and the state.json
// read could only ever report nothing left to move. Every command
// loads the project list, so that read is a whole file parsed for
// nothing on every invocation, forever. A crash in the window between
// the two writes does leave a stale copy of the keys behind in
// state.json, and it stays there. Nothing reads it: the registry keys
// are only ever read from registry.json, and state.json is only ever
// asked for the keys it owns.
//
// Two processes starting against the same old root are safe because
// state.json is read again inside its lock. The loser of the race
// finds nothing left to move and writes nothing. Both locks are taken,
// state.json's outside registry.json's. Nothing else takes both, so
// the order can't deadlock.
var registrySplitDone bool

func ensureRegistrySplit() error {
	if registrySplitDone {
		return nil
	}
	if _, err := os.Stat(registryPath()); err == nil {
		registrySplitDone = true
		return nil
	}
	state, err := readJSONObject(statePath())
	if err != nil {
		// The source is unreadable and there is no registry.json to
		// read instead, so the registry is genuinely unknown. Answering
		// "no projects" is the failure the strict read exists to
		// prevent. Once registry.json does exist the stat above returns
		// first, and state.json's trouble belongs to the use logs,
		// which report it on their own reads.
		return err
	}
	if !holdsAnyRegistryKey(state) {
		registrySplitDone = true
		return nil
	}
	if err := withFileLock(statePath(), splitLocked); err != nil {
		return err
	}
	registrySplitDone = true
	return nil
}

func holdsAnyRegistryKey(doc map[string]json.RawMessage) bool {
	for _, key := range registryKeys {
		if _, ok := doc[key]; ok {
			return true
		}
	}
	return false
}

// Runs under the state.json lock.
func splitLocked() error {
	current, err := readJSONObject(statePath())
	if err != nil {
		return err
	}
	moving := []string{}
	for _, key := range registryKeys {
		if _, ok := current[key]; ok {
			moving = append(moving, key)
		}
	}
	if len(moving) == 0 {
		return nil
	}
	err = withFileLock(registryPath(), func() error {
		registry, err := readJSONObject(registryPath())
		if err != nil {
			return err
		}
		changed := false
		for _, key := range moving {
			if _, ok := registry[key]; ok {
				continue
			}
			registry[key] = current[key]
			changed = true
		}
		if !changed {
			return nil
		}
		return writeJSONObject(registryPath(), registry)
	})
	if err != nil {
		return err
	}
	for _, key := range moving {
		delete(current, key)
	}
	return writeJSONObject(statePath(), current)
}

// Flips the id in the shelved map (store.ts writeKey semantics).
func setShelved(worktreeID string, shelved bool) error {
	return updateRegistryKey(shelvedKey, func(raw json.RawMessage) (any, error) {
		m := map[string]bool{}
		if err := decodeKey(registryPath(), shelvedKey, raw, &m); err != nil {
			return nil, err
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

// Missing reads as defaults. A file that exists but can't be read or
// parsed is an error. deleteBranchOnRemove decides whether `sm rm`
// deletes a branch, so a corrupt config.json must not quietly read as
// "unset" -- that flips an explicit opt-out back to the destructive
// default. Same rule readJSONObject applies to the registry.
func readGlobalConfig() (globalConfig, error) {
	var cfg globalConfig
	_, err := readJSONDoc(configJSONPath(), func(raw []byte) error {
		return json.Unmarshal(raw, &cfg)
	})
	return cfg, err
}

// For display paths (launcher lists, hidden-launcher filters,
// port-pool detection): degrade to defaults with a one-time warning
// instead of blocking the command. Anything that makes a destructive
// decision from the config takes readGlobalConfig directly.
func readGlobalConfigHints() globalConfig {
	cfg, err := readGlobalConfig()
	if err != nil {
		noteFileTrouble(configJSONPath(),
			"Global settings read as defaults until the file is fixed.", err)
		// Not cfg: a type error leaves it partially decoded, and the
		// warning just promised defaults.
		return globalConfig{}
	}
	return cfg
}

// nil when the file is missing, unreadable, or fails the schema's
// required-field check -- matching the app's null-on-invalid behavior.
// A missing file or absent defaultBranch is the ordinary
// pre-configure state and stays silent. A file that exists but can't
// be read or parsed gets a one-time warning, because nil here means
// carry-over, setup and teardown silently don't run.
func readProjectConfig(projectID string) *projectConfig {
	path := projectConfigJSONPath(projectID)
	var cfg projectConfig
	found, err := readJSONDoc(path, func(raw []byte) error {
		return json.Unmarshal(raw, &cfg)
	})
	if err != nil {
		noteFileTrouble(path,
			"Carry-over and the setup/teardown scripts are skipped until the file is fixed.", err)
		return nil
	}
	if !found || strings.TrimSpace(cfg.DefaultBranch) == "" {
		return nil
	}
	return &cfg
}

func deleteWorktreeData(projectID, worktreeID string) {
	path := worktreeDataPath(projectID, worktreeID)
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

// --- cross-process file locks (host/lib/util/lockFile.ts protocol) ---

const (
	lockStale   = 10 * time.Second
	lockTimeout = 5 * time.Second
	lockRetry   = 25 * time.Millisecond
)

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
