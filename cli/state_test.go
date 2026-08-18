package main

// Tests for state-root resolution (initRoot): SHIGOMORI_ROOT beats the
// pointer file, the pointer file beats the flavor default, and
// malformed pointer content (blank, relative path) falls through to
// the default. Plus the state.json read guard: only an absent file
// reads as empty, so a write can never rebuild the file from a failed
// read, and the schema marker every write stamps. Everything runs
// against a temp HOME, so no real state root or config is ever
// touched.

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// initRoot writes the package-global cachedRoot. Run it against a
// clean slate and restore whatever the process had.
func initRootT(t *testing.T) string {
	t.Helper()
	saved := cachedRoot
	cachedRoot = ""
	t.Cleanup(func() { cachedRoot = saved })
	initRoot()
	return cachedRoot
}

func writePointer(t *testing.T, configHome, content string) {
	t.Helper()
	dir := filepath.Join(configHome, rootDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "root"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// sandboxHome (cmd_shell_test.go) plus clearing the root override, so
// initRoot resolves purely from the sandboxed HOME.
func sandboxRootEnv(t *testing.T) string {
	t.Helper()
	home := sandboxHome(t)
	t.Setenv("SHIGOMORI_ROOT", "")
	return home
}

func TestInitRootDefault(t *testing.T) {
	home := sandboxRootEnv(t)
	if got, want := initRootT(t), filepath.Join(home, rootDirName); got != want {
		t.Errorf("root = %q, want %q", got, want)
	}
}

func TestInitRootPointerFile(t *testing.T) {
	home := sandboxRootEnv(t)
	target := filepath.Join(home, "Elsewhere", "sm-state")
	writePointer(t, filepath.Join(home, ".config"), target+"\n")
	if got := initRootT(t); got != target {
		t.Errorf("root = %q, want %q", got, target)
	}
}

func TestInitRootPointerTilde(t *testing.T) {
	home := sandboxRootEnv(t)
	writePointer(t, filepath.Join(home, ".config"), "~/moved-root\n")
	if got, want := initRootT(t), filepath.Join(home, "moved-root"); got != want {
		t.Errorf("root = %q, want %q", got, want)
	}
}

func TestInitRootPointerRespectsXDGConfigHome(t *testing.T) {
	home := sandboxRootEnv(t)
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	target := filepath.Join(home, "xdg-target")
	writePointer(t, configHome, target)
	// A decoy in the default location proves XDG_CONFIG_HOME wins.
	writePointer(t, filepath.Join(home, ".config"), filepath.Join(home, "decoy"))
	if got := initRootT(t); got != target {
		t.Errorf("root = %q, want %q", got, target)
	}
}

func TestInitRootPointerMalformed(t *testing.T) {
	for _, content := range []string{"", "   \n", "relative/path\n"} {
		home := sandboxRootEnv(t)
		writePointer(t, filepath.Join(home, ".config"), content)
		if got, want := initRootT(t), filepath.Join(home, rootDirName); got != want {
			t.Errorf("content %q: root = %q, want %q", content, got, want)
		}
	}
}

func TestInitRootPointerRefusesForeignDir(t *testing.T) {
	home := sandboxRootEnv(t)
	// A directory full of unrelated files (a hand-edit mistake like
	// pointing at ~/Documents) must not be adopted as the state root.
	foreign := filepath.Join(home, "documents")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "essay.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	writePointer(t, filepath.Join(home, ".config"), foreign)
	if got, want := initRootT(t), filepath.Join(home, rootDirName); got != want {
		t.Errorf("root = %q, want default %q", got, want)
	}
}

func TestInitRootPointerAcceptsExistingRoot(t *testing.T) {
	home := sandboxRootEnv(t)
	moved := filepath.Join(home, "moved-root")
	if err := os.MkdirAll(moved, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moved, "state.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writePointer(t, filepath.Join(home, ".config"), moved)
	if got := initRootT(t); got != moved {
		t.Errorf("root = %q, want %q", got, moved)
	}
}

func TestInitRootEnvBeatsPointer(t *testing.T) {
	home := sandboxRootEnv(t)
	envRoot := filepath.Join(home, "env-root")
	t.Setenv("SHIGOMORI_ROOT", envRoot)
	writePointer(t, filepath.Join(home, ".config"), filepath.Join(home, "pointer-root"))
	if got := initRootT(t); got != envRoot {
		t.Errorf("root = %q, want %q", got, envRoot)
	}
}

// --- state.json reads (store.ts readAll parity) ---

func seedState(t *testing.T, content string) {
	t.Helper()
	if err := os.WriteFile(statePath(), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func seedRegistry(t *testing.T, content string) {
	t.Helper()
	if err := os.WriteFile(registryPath(), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func shelveViaRegistry() error {
	return setShelved("w1", true)
}

// The write every click makes: a use-log bump, the one that turned a
// failed read into a one-key state.json.
func bumpUseLog() error {
	return updateStateKey("projectUseLog", func(json.RawMessage) (any, error) {
		return map[string][]int64{"p1": {2}}, nil
	})
}

func TestReadStateFileMissingIsEmpty(t *testing.T) {
	sandboxConfigRoot(t)
	all, err := readStateFile()
	if err != nil || len(all) != 0 {
		t.Errorf("read of absent state.json = %v, %v, want empty", all, err)
	}
	if err := bumpUseLog(); err != nil {
		t.Errorf("write against absent state.json: %v", err)
	}
	if _, err := os.Stat(statePath()); err != nil {
		t.Errorf("write did not create state.json: %v", err)
	}
}

func TestUpdateStateKeyRefusesMalformedState(t *testing.T) {
	sandboxConfigRoot(t)
	broken := `{"projects": [{"id": "p1"`
	seedState(t, broken)
	if err := bumpUseLog(); err == nil {
		t.Error("write against malformed state.json succeeded, want error")
	}
	if raw, err := os.ReadFile(statePath()); err != nil || string(raw) != broken {
		t.Errorf("malformed state.json was rewritten to %q", raw)
	}
}

func TestUpdateStateKeyRefusesUnreadableState(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads through mode 0000")
	}
	sandboxConfigRoot(t)
	kept := `{"projects":[{"id":"p1","name":"alpha","path":"/tmp/alpha"}],` +
		`"shelvedWorktrees":{"w1":true},"projectUseLog":{"p1":[1]}}`
	seedState(t, kept)
	// The mode stays off for the whole write: restoring it first would
	// let the read succeed, which is exactly what hid the bug. The
	// directory stays writable, so the rename half of the write could
	// still land.
	if err := os.Chmod(statePath(), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(statePath(), 0o644) })
	if _, err := loadProjects(); err == nil {
		t.Error("loadProjects on unreadable state.json succeeded, want error")
	}
	if _, err := os.Stat(registryPath()); err == nil {
		t.Error("failed split still created registry.json")
	}
	if err := bumpUseLog(); err == nil {
		t.Error("write against unreadable state.json succeeded, want error")
	}
	if err := os.Chmod(statePath(), 0o644); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(statePath()); err != nil || string(raw) != kept {
		t.Errorf("unreadable state.json was rewritten to %q", raw)
	}
}

// --- the schema marker ---

func TestStateWriteStampsSchemaVersion(t *testing.T) {
	sandboxConfigRoot(t)
	if err := bumpUseLog(); err != nil {
		t.Fatal(err)
	}
	all, err := readStateFile()
	if err != nil {
		t.Fatal(err)
	}
	if got := string(all["schemaVersion"]); got != "1" {
		t.Errorf("schemaVersion = %q, want 1", got)
	}
}

// Neither an absent marker (every file written before it existed) nor
// one from a build that doesn't exist yet may stop a read. The write
// that follows stamps this build's version either way: it wrote the
// file, so it says so.
func TestStateReadToleratesOtherSchemaVersions(t *testing.T) {
	sandboxConfigRoot(t)
	list := `"projects":[{"id":"p1","name":"alpha","path":"/tmp/alpha"}]`
	seedRegistry(t, "{"+list+"}")
	if projects, err := loadProjects(); err != nil || len(projects) != 1 {
		t.Errorf("read of unmarked registry.json = %v, %v, want the project", projects, err)
	}
	seedRegistry(t, `{"schemaVersion":99,`+list+"}")
	if projects, err := loadProjects(); err != nil || len(projects) != 1 {
		t.Errorf("read of newer registry.json = %v, %v, want the project", projects, err)
	}
	seedState(t, `{"schemaVersion":99,"projectUseLog":{"p1":[1]}}`)
	if err := bumpUseLog(); err != nil {
		t.Fatalf("write against newer state.json: %v", err)
	}
	all, err := readStateFile()
	if err != nil {
		t.Fatal(err)
	}
	if got := string(all["schemaVersion"]); got != "1" {
		t.Errorf("schemaVersion after write = %q, want this build's 1", got)
	}
	if err := shelveViaRegistry(); err != nil {
		t.Fatalf("write against newer registry.json: %v", err)
	}
	registry, err := readRegistryFile()
	if err != nil {
		t.Fatal(err)
	}
	if got := string(registry["schemaVersion"]); got != "1" {
		t.Errorf("registry schemaVersion after write = %q, want this build's 1", got)
	}
	if len(registry[projectsKey]) == 0 {
		t.Error("write against newer registry.json dropped the project registry")
	}
}

// --- the registry split ---

// Every key an old-format root could hold, so the split has something
// to lose on both sides of the line.
const oldFormatState = `{
  "projects": [{"id": "p1", "name": "alpha", "path": "/tmp/alpha"}],
  "shelvedWorktrees": {"w1": true},
  "projectUseLog": {"p1": [1]},
  "packageScriptUseLog": {"p1": {"dev": [2]}},
  "launcherUseLog": {"vscode": [3]},
  "projectsCollapsed": ["p1"],
  "projectsSort": "recent",
  "packageScriptSort": {"p1": "alpha"},
  "someKeyNobodyModels": 7
}`

func readFile(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return doc
}

// The registry lands in registry.json, the telemetry and the UI
// preferences stay in state.json, and no key goes missing on the way.
func TestRegistrySplitMovesOnlyTheRegistry(t *testing.T) {
	sandboxConfigRoot(t)
	seedState(t, oldFormatState)

	projects, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].ID != "p1" {
		t.Fatalf("projects after split = %v, want the seeded one", projects)
	}
	if shelved := readShelvedSet(); !shelved["w1"] {
		t.Errorf("shelf after split = %v, want w1", shelved)
	}

	registry := readFile(t, registryPath())
	for _, key := range registryKeys {
		if len(registry[key]) == 0 {
			t.Errorf("registry.json missing %s", key)
		}
	}
	if got := string(registry["schemaVersion"]); got != "1" {
		t.Errorf("registry.json schemaVersion = %q, want 1", got)
	}
	if len(registry) != len(registryKeys)+1 {
		t.Errorf("registry.json picked up extra keys: %v", registry)
	}

	state := readFile(t, statePath())
	for _, key := range registryKeys {
		if _, ok := state[key]; ok {
			t.Errorf("state.json still holds %s", key)
		}
	}
	for _, key := range []string{
		"projectUseLog", "packageScriptUseLog", "launcherUseLog",
		"projectsCollapsed", "projectsSort", "packageScriptSort",
		"someKeyNobodyModels",
	} {
		if len(state[key]) == 0 {
			t.Errorf("split dropped %s from state.json", key)
		}
	}
}

// Running it again must rewrite nothing: the second pass has no keys
// left to move, so both files keep the bytes the first pass left.
func TestRegistrySplitIsIdempotent(t *testing.T) {
	sandboxConfigRoot(t)
	seedState(t, oldFormatState)
	if _, err := loadProjects(); err != nil {
		t.Fatal(err)
	}
	firstState, err := os.ReadFile(statePath())
	if err != nil {
		t.Fatal(err)
	}
	firstRegistry, err := os.ReadFile(registryPath())
	if err != nil {
		t.Fatal(err)
	}

	// A second process against the already-split root.
	registrySplitDone = false
	projects, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 {
		t.Errorf("projects on the second pass = %v, want the one", projects)
	}
	if raw, _ := os.ReadFile(statePath()); string(raw) != string(firstState) {
		t.Errorf("second pass rewrote state.json to %q", raw)
	}
	if raw, _ := os.ReadFile(registryPath()); string(raw) != string(firstRegistry) {
		t.Errorf("second pass rewrote registry.json to %q", raw)
	}
}

// A crash between the two writes leaves registry.json written and
// state.json still carrying the old copy. The next pass must finish the
// job without letting the stale copy overwrite the live one.
func TestRegistrySplitFinishesAfterCrash(t *testing.T) {
	sandboxConfigRoot(t)
	seedState(t, oldFormatState)
	// What the crashed run had already written, plus the project the
	// user added afterwards through the file that now holds the truth.
	seedRegistry(t, `{"projects":[`+
		`{"id":"p1","name":"alpha","path":"/tmp/alpha"},`+
		`{"id":"p2","name":"beta","path":"/tmp/beta"}],`+
		`"shelvedWorktrees":{"w1":true},"schemaVersion":1}`)

	projects, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 {
		t.Errorf("projects = %v, want registry.json's two", projects)
	}
	state := readFile(t, statePath())
	for _, key := range registryKeys {
		if _, ok := state[key]; ok {
			t.Errorf("second pass left %s in state.json", key)
		}
	}
	if len(state["projectUseLog"]) == 0 {
		t.Error("second pass dropped the use log")
	}
}

// Half a split is still recoverable, so the unreadable half must not be
// papered over: with no registry.json yet, the project list is unknown
// and answering with an empty one is the failure this refuses.
func TestRegistrySplitRefusesUnreadableState(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads through mode 0000")
	}
	sandboxConfigRoot(t)
	seedState(t, oldFormatState)
	if err := os.Chmod(statePath(), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(statePath(), 0o644) })
	if _, err := loadProjects(); err == nil {
		t.Error("loadProjects against an unreadable unsplit root succeeded, want error")
	}

	// Once registry.json exists the registry is knowable again, and
	// state.json's trouble stays state.json's.
	seedRegistry(t, `{"projects":[{"id":"p1","name":"alpha","path":"/tmp/alpha"}]}`)
	registrySplitDone = false
	if projects, err := loadProjects(); err != nil || len(projects) != 1 {
		t.Errorf("loadProjects from registry.json = %v, %v, want the project", projects, err)
	}
}

// The point of the split: a use-log bump, which fires on nearly every
// click, must leave the registry file untouched.
func TestUseLogWriteLeavesRegistryAlone(t *testing.T) {
	sandboxConfigRoot(t)
	seedState(t, oldFormatState)
	if _, err := loadProjects(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(registryPath())
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(registryPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := bumpUseLog(); err != nil {
		t.Fatal(err)
	}
	afterInfo, err := os.Stat(registryPath())
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(registryPath()); string(raw) != string(before) {
		t.Errorf("use-log bump rewrote registry.json to %q", raw)
	}
	if !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Error("use-log bump touched registry.json")
	}
}

// A fresh root has no state.json to drain, and the first registry write
// creates registry.json rather than resurrecting the old shape.
func TestRegistrySplitOnFreshRoot(t *testing.T) {
	sandboxConfigRoot(t)
	if projects, err := loadProjects(); err != nil || len(projects) != 0 {
		t.Errorf("fresh root = %v, %v, want empty", projects, err)
	}
	if _, err := os.Stat(registryPath()); err == nil {
		t.Error("a read on a fresh root created registry.json")
	}
	if err := setShelved("w1", true); err != nil {
		t.Fatal(err)
	}
	if len(readFile(t, registryPath())[shelvedKey]) == 0 {
		t.Error("shelve did not land in registry.json")
	}
	if _, err := os.Stat(statePath()); err == nil {
		t.Error("a registry write created state.json")
	}
}

// --- a broken state.json is loud without being fatal ---

// note/vlog write to os.Stderr through the package variable, so
// swapping it is enough to read back what a command would have shown.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = w
	fn()
	os.Stderr = saved
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	printed, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	return string(printed)
}

// Nothing reads state.json before a command dispatches any more, so
// the hint reads and the use-log writes are the only places left that
// can notice it is broken. They carry on, and they say so once.
func TestBrokenStateWarnsOnceAndKeepsWorking(t *testing.T) {
	sandboxConfigRoot(t)
	seedRegistry(t, `{"projects":[{"id":"p1","name":"alpha","path":"/tmp/alpha"}],`+
		`"shelvedWorktrees":{"w1":true},"schemaVersion":1}`)
	broken := `{"launcherUseLog": {"app:finder": [1`
	seedState(t, broken)

	var projects []project
	var shelved map[string]bool
	var hints map[string]json.RawMessage
	var writeErr error
	printed := captureStderr(t, func() {
		var err error
		if projects, err = loadProjects(); err != nil {
			t.Errorf("loadProjects with an intact registry.json: %v", err)
		}
		shelved = readShelvedSet()
		hints = readStateHints()
		readStateHints()
		writeErr = bumpUseLog()
	})

	if len(projects) != 1 || !shelved["w1"] {
		t.Errorf("registry.json reads = %v, %v, want the project and the shelf", projects, shelved)
	}
	if len(hints) != 0 {
		t.Errorf("hints from a broken state.json = %v, want empty", hints)
	}
	if writeErr == nil {
		t.Error("write against a broken state.json succeeded, want the refusal")
	}
	if got := strings.Count(printed, "warning:"); got != 1 {
		t.Errorf("warnings printed = %d, want exactly 1:\n%s", got, printed)
	}
	if !strings.Contains(printed, statePath()) {
		t.Errorf("warning does not name state.json:\n%s", printed)
	}
	if raw, err := os.ReadFile(statePath()); err != nil || string(raw) != broken {
		t.Errorf("broken state.json was rewritten to %q", raw)
	}
}

// The same paths on a healthy root say nothing at all.
func TestHealthyRootPrintsNoWarning(t *testing.T) {
	sandboxConfigRoot(t)
	seedRegistry(t, `{"projects":[{"id":"p1","name":"alpha","path":"/tmp/alpha"}],"schemaVersion":1}`)
	seedState(t, `{"launcherUseLog":{"app:finder":[1]},"schemaVersion":1}`)
	printed := captureStderr(t, func() {
		if _, err := loadProjects(); err != nil {
			t.Error(err)
		}
		readShelvedSet()
		readStateHints()
		if err := bumpUseLog(); err != nil {
			t.Error(err)
		}
	})
	if printed != "" {
		t.Errorf("healthy root printed:\n%s", printed)
	}
}
