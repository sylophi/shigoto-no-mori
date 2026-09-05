package main

// Tests for the config key engine (cmd_config.go) and the project
// config verbs built on it: value parsing, omit-on-default
// normalization, dotted-path nesting with parent pruning, preservation
// of keys the CLI doesn't model, and the guards around the required
// defaultBranch. Everything runs against a temp SHIGOMORI_DATA_DIR.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sandboxDataDir(t *testing.T) string {
	t.Helper()
	// Symlink-free: git answers with resolved paths, and the checks that
	// compare against them do it byte for byte.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHIGOMORI_DATA_DIR", root)
	saved := cachedDataDir
	cachedDataDir = ""
	t.Cleanup(func() { cachedDataDir = saved })
	// Per-data-dir memo: a fresh sandbox has to look unsplit again, or a
	// test that seeds an old-format state.json would silently skip it.
	registrySplitDone = false
	t.Cleanup(func() { registrySplitDone = false })
	if err := initDataDir(); err != nil {
		t.Fatal(err)
	}
	return root
}

// A registered-looking project whose path is not a git repo, so
// defaultBranch backfill resolves to nothing and stays out of the way.
func testProject(t *testing.T) project {
	t.Helper()
	return project{ID: "TESTPROJECT", Name: "fox", Path: t.TempDir()}
}

// The scope refuses to write a defaultBranch-less document, and the
// test project's dir isn't a repo to backfill from -- seed the branch
// so tests can exercise the other keys.
func seededProject(t *testing.T) project {
	t.Helper()
	proj := testProject(t)
	if code, err := runConfigSet(projectConfigScope(proj), "defaultBranch", "main"); code != 0 || err != nil {
		t.Fatalf("seed defaultBranch: %d, %v", code, err)
	}
	return proj
}

func readDoc(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	doc, err := decodeConfigDoc(raw)
	if err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return doc
}

func TestParseConfigValueBoolForms(t *testing.T) {
	key := configKey{name: "launchScripts", kind: boolKind}
	for raw, want := range map[string]bool{
		"true": true, "on": true, "yes": true, "1": true, "TRUE": true,
		"false": false, "off": false, "no": false, "0": false,
	} {
		got, err := parseConfigValue(key, raw)
		if err != nil || got != want {
			t.Errorf("parse %q = %v, %v, want %v", raw, got, err, want)
		}
	}
	if _, err := parseConfigValue(key, "maybe"); err == nil {
		t.Error("parse \"maybe\" succeeded, want error")
	}
}

func TestParseConfigValueEnumAndInt(t *testing.T) {
	layout := configKey{name: "worktreeLayout", kind: enumKind, enum: []string{"managed-root", "in-project", "custom"}}
	if got, err := parseConfigValue(layout, "in-project"); err != nil || got != "in-project" {
		t.Errorf("parse in-project = %v, %v", got, err)
	}
	if _, err := parseConfigValue(layout, "somewhere"); err == nil {
		t.Error("parse somewhere succeeded, want error")
	}
	portBase := configKey{name: "portBase", kind: intKind}
	if got, err := parseConfigValue(portBase, "5170"); err != nil || got != 5170 {
		t.Errorf("parse 5170 = %v, %v", got, err)
	}
	for _, raw := range []string{"0", "-3", "many"} {
		if _, err := parseConfigValue(portBase, raw); err == nil {
			t.Errorf("parse %q succeeded, want error", raw)
		}
	}
}

func TestGlobalConfigSetNormalizesDefaults(t *testing.T) {
	sandboxDataDir(t)
	if code, err := runConfigSet(globalConfigScope(), "launchScripts", "false"); code != 0 || err != nil {
		t.Fatalf("set launchScripts false: %d, %v", code, err)
	}
	doc := readDoc(t, configJSONPath())
	if doc["launchScripts"] != false {
		t.Errorf("launchScripts = %v, want false", doc["launchScripts"])
	}
	// Setting the default removes the key, matching the app's
	// omit-on-default serialization.
	if code, err := runConfigSet(globalConfigScope(), "launchScripts", "true"); code != 0 || err != nil {
		t.Fatalf("set launchScripts true: %d, %v", code, err)
	}
	if _, ok := readDoc(t, configJSONPath())["launchScripts"]; ok {
		t.Error("launchScripts still present after being set to its default")
	}
	if code, err := runConfigSet(globalConfigScope(), "deleteBranchOnRemove", "off"); code != 0 || err != nil {
		t.Fatalf("set deleteBranchOnRemove off: %d, %v", code, err)
	}
	if got := readDoc(t, configJSONPath())["deleteBranchOnRemove"]; got != false {
		t.Errorf("deleteBranchOnRemove = %v, want false", got)
	}
	if code, err := runConfigUnset(globalConfigScope(), "deleteBranchOnRemove"); code != 0 || err != nil {
		t.Fatalf("unset deleteBranchOnRemove: %d, %v", code, err)
	}
	if _, ok := readDoc(t, configJSONPath())["deleteBranchOnRemove"]; ok {
		t.Error("deleteBranchOnRemove still present after unset")
	}
}

func TestGlobalConfigPreservesOtherKeys(t *testing.T) {
	sandboxDataDir(t)
	// theme is a legacy client key the registry no longer models. It
	// must ride through device writes untouched, like any unknown key.
	seed := `{"portPool": true, "theme": "dark", "futureKey": {"nested": 12345678901234567890}}` + "\n"
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigSet(globalConfigScope(), "launchScripts", "false"); code != 0 || err != nil {
		t.Fatalf("set launchScripts false: %d, %v", code, err)
	}
	doc := readDoc(t, configJSONPath())
	if doc["portPool"] != true {
		t.Errorf("portPool = %v, want true", doc["portPool"])
	}
	if doc["theme"] != "dark" {
		t.Errorf("theme = %v, want the legacy value untouched", doc["theme"])
	}
	// Unknown keys survive verbatim, including numbers a float64
	// round-trip would mangle.
	nested, _ := configDocGet(doc, "futureKey.nested")
	if renderConfigValue(nested) != "12345678901234567890" {
		t.Errorf("futureKey.nested = %v, want the untouched literal", nested)
	}
}

// The socketHost kill switch and omit-on-default contract: setting the
// nested enabled flag creates the object, setting it back to its false
// default deletes just that leaf, unsetting the last leaf prunes the
// whole object, and a whole-document write that omits socketHost clears
// a previously enabled listener rather than leaving a stale token.
func TestSocketHostConfigKeys(t *testing.T) {
	sandboxDataDir(t)
	// Enable and set a token (the app normally generates the token, but
	// a set must still land it for the whole-document write to validate).
	if code, err := runConfigSet(globalConfigScope(), "socketHost.enabled", "true"); code != 0 || err != nil {
		t.Fatalf("set socketHost.enabled true: %d, %v", code, err)
	}
	if code, err := runConfigSet(globalConfigScope(), "socketHost.token", "s3cret-token"); code != 0 || err != nil {
		t.Fatalf("set socketHost.token: %d, %v", code, err)
	}
	if got, _ := configDocGet(readDoc(t, configJSONPath()), "socketHost.enabled"); got != true {
		t.Errorf("socketHost.enabled = %v, want true", got)
	}

	// The kill switch: setting enabled to its false default deletes the
	// leaf, so the app resolver sees no enabled:true and stops the
	// listener. The token leaf must survive that (only enabled changed).
	if code, err := runConfigSet(globalConfigScope(), "socketHost.enabled", "false"); code != 0 || err != nil {
		t.Fatalf("set socketHost.enabled false: %d, %v", code, err)
	}
	doc := readDoc(t, configJSONPath())
	if _, ok := configDocGet(doc, "socketHost.enabled"); ok {
		t.Error("socketHost.enabled still present after being set to its false default")
	}
	if got, _ := configDocGet(doc, "socketHost.token"); got != "s3cret-token" {
		t.Errorf("socketHost.token = %v, want it to survive the enabled toggle", got)
	}

	// Unsetting the last remaining leaf prunes the emptied parent object.
	if code, err := runConfigUnset(globalConfigScope(), "socketHost.token"); code != 0 || err != nil {
		t.Fatalf("unset socketHost.token: %d, %v", code, err)
	}
	if _, ok := readDoc(t, configJSONPath())["socketHost"]; ok {
		t.Error("socketHost object still present after its last leaf was unset")
	}

	// Omit-on-default write path: a whole-document save that omits
	// socketHost must clear a previously enabled listener, not leave a
	// stale enabled:true and token on disk.
	if code, err := runConfigSet(globalConfigScope(), "socketHost.enabled", "true"); code != 0 || err != nil {
		t.Fatalf("re-enable socketHost: %d, %v", code, err)
	}
	if code, err := runConfigWrite(globalConfigScope(), `{"launchScripts": false}`); code != 0 || err != nil {
		t.Fatalf("write omitting socketHost: %d, %v", code, err)
	}
	if _, ok := readDoc(t, configJSONPath())["socketHost"]; ok {
		t.Error("socketHost survived a whole-document write that omitted it")
	}
}

func TestGlobalConfigSetRejects(t *testing.T) {
	sandboxDataDir(t)
	for name, raw := range map[string]string{
		"noSuchKey":     "1",     // unknown key
		"launchScripts": "maybe", // bad bool
		"launchers":     "[]",    // structured
	} {
		if code, err := runConfigSet(globalConfigScope(), name, raw); code != 2 || err == nil {
			t.Errorf("set %s %q = %d, %v, want usage error", name, raw, code, err)
		}
	}
}

// The client keys moved to the app's clientConfig.json store. Setting
// them here must fail with the normal unknown-key error that names the
// device keys which remain, plus a hint pointing at the keys' new home.
func TestGlobalConfigRejectsClientKeys(t *testing.T) {
	sandboxDataDir(t)
	for _, name := range []string{"theme", "doubutsu"} {
		code, err := runConfigSet(globalConfigScope(), name, "dark")
		if code != 2 || err == nil {
			t.Fatalf("set %s = %d, %v, want unknown-key usage error", name, code, err)
		}
		msg := err.Error()
		if !strings.Contains(msg, "Unknown key") || !strings.Contains(msg, "launchScripts") {
			t.Errorf("set %s error = %q, want the unknown-key message listing device keys", name, msg)
		}
		if !strings.Contains(msg, "Settings -> Appearance") {
			t.Errorf("set %s error = %q, want the client-settings hint", name, msg)
		}
	}
}

func TestProjectConfigScriptsNesting(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	path := projectConfigJSONPath(proj.ID)
	if code, err := runConfigSet(projectConfigScope(proj), "scripts.setup", "pnpm install"); code != 0 || err != nil {
		t.Fatalf("set scripts.setup: %d, %v", code, err)
	}
	if code, err := runConfigSet(projectConfigScope(proj), "scripts.teardown", "pnpm down"); code != 0 || err != nil {
		t.Fatalf("set scripts.teardown: %d, %v", code, err)
	}
	if got, _ := configDocGet(readDoc(t, path), "scripts.setup"); got != "pnpm install" {
		t.Errorf("scripts.setup = %v", got)
	}
	// "" clears, like the long-standing --setup '' behavior. The
	// sibling stays put.
	if code, err := runConfigSet(projectConfigScope(proj), "scripts.setup", ""); code != 0 || err != nil {
		t.Fatalf("clear scripts.setup: %d, %v", code, err)
	}
	doc := readDoc(t, path)
	if _, ok := configDocGet(doc, "scripts.setup"); ok {
		t.Error("scripts.setup still present after clearing")
	}
	if got, _ := configDocGet(doc, "scripts.teardown"); got != "pnpm down" {
		t.Errorf("scripts.teardown = %v, want pnpm down", got)
	}
	// Removing the last script prunes the emptied scripts object.
	if code, err := runConfigUnset(projectConfigScope(proj), "scripts.teardown"); code != 0 || err != nil {
		t.Fatalf("unset scripts.teardown: %d, %v", code, err)
	}
	if _, ok := readDoc(t, path)["scripts"]; ok {
		t.Error("scripts object not pruned after its last key was removed")
	}
}

func TestProjectConfigDefaultBranchGuards(t *testing.T) {
	sandboxDataDir(t)
	proj := testProject(t)
	if code, err := runConfigSet(projectConfigScope(proj), "defaultBranch", ""); code != 2 || err == nil {
		t.Errorf("set defaultBranch \"\" = %d, %v, want usage error", code, err)
	}
	if code, err := runConfigUnset(projectConfigScope(proj), "defaultBranch"); code != 2 || err == nil {
		t.Errorf("unset defaultBranch = %d, %v, want usage error", code, err)
	}
	if code, err := runConfigSet(projectConfigScope(proj), "defaultBranch", "main"); code != 0 || err != nil {
		t.Fatalf("set defaultBranch main: %d, %v", code, err)
	}
	if got := readDoc(t, projectConfigJSONPath(proj.ID))["defaultBranch"]; got != "main" {
		t.Errorf("defaultBranch = %v, want main", got)
	}
}

func TestProjectConfigBoolAndPathKeys(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	path := projectConfigJSONPath(proj.ID)
	// Default true: explicit true stays out of the file, false is the
	// stored opt-out -- the app's serialization exactly.
	if code, err := runConfigSet(projectConfigScope(proj), "useWorktreeInclude", "true"); code != 0 || err != nil {
		t.Fatalf("set useWorktreeInclude true: %d, %v", code, err)
	}
	if _, ok := readDoc(t, path)["useWorktreeInclude"]; ok {
		t.Error("useWorktreeInclude stored despite matching its default")
	}
	if code, err := runConfigSet(projectConfigScope(proj), "useWorktreeInclude", "false"); code != 0 || err != nil {
		t.Fatalf("set useWorktreeInclude false: %d, %v", code, err)
	}
	if got := readDoc(t, path)["useWorktreeInclude"]; got != false {
		t.Errorf("useWorktreeInclude = %v, want false", got)
	}
	if code, err := runConfigSet(projectConfigScope(proj), "customWorktreePath", "relative/dir"); code != 2 || err == nil {
		t.Errorf("relative customWorktreePath accepted: %d, %v", code, err)
	}
	abs := t.TempDir()
	if code, err := runConfigSet(projectConfigScope(proj), "customWorktreePath", abs); code != 0 || err != nil {
		t.Fatalf("set customWorktreePath: %d, %v", code, err)
	}
	if got := readDoc(t, path)["customWorktreePath"]; got != abs {
		t.Errorf("customWorktreePath = %v, want %s", got, abs)
	}
}

func TestLauncherAddRm(t *testing.T) {
	sandboxDataDir(t)
	scope := globalConfigScope()
	if code, err := runLauncherVerb(scope, []string{"add", "Claude", "claude"}); code != 0 || err != nil {
		t.Fatalf("add Claude: %d, %v", code, err)
	}
	if code, err := runLauncherVerb(scope, []string{"add", "Tmux", "tmux new-session"}); code != 0 || err != nil {
		t.Fatalf("add Tmux: %d, %v", code, err)
	}
	launchers, _ := readDoc(t, scope.path)["launchers"].([]any)
	if len(launchers) != 2 {
		t.Fatalf("launchers = %v, want 2 entries", launchers)
	}
	first, _ := launchers[0].(map[string]any)
	if first["label"] != "Claude" || first["command"] != "claude" {
		t.Errorf("first launcher = %v", first)
	}
	if id, _ := first["id"].(string); len(id) != 36 {
		t.Errorf("id = %q, want a uuid-shaped string", id)
	}
	// rm by label, case-insensitive.
	if code, err := runLauncherVerb(scope, []string{"rm", "claude"}); code != 0 || err != nil {
		t.Fatalf("rm claude: %d, %v", code, err)
	}
	launchers, _ = readDoc(t, scope.path)["launchers"].([]any)
	if len(launchers) != 1 {
		t.Fatalf("launchers after rm = %v", launchers)
	}
	// Removing the last entry omits the key, like the app.
	if code, err := runLauncherVerb(scope, []string{"rm", "Tmux"}); code != 0 || err != nil {
		t.Fatalf("rm Tmux: %d, %v", code, err)
	}
	if _, ok := readDoc(t, scope.path)["launchers"]; ok {
		t.Error("launchers key still present after removing the last entry")
	}
	if code, err := runLauncherVerb(scope, []string{"rm", "Ghost"}); code != 1 || err == nil {
		t.Errorf("rm Ghost = %d, %v, want not-found error", code, err)
	}
}

func TestLauncherRmAmbiguousLabel(t *testing.T) {
	sandboxDataDir(t)
	scope := globalConfigScope()
	for range 2 {
		if code, err := runLauncherVerb(scope, []string{"add", "Editor", "code ."}); code != 0 || err != nil {
			t.Fatalf("add Editor: %d, %v", code, err)
		}
	}
	if code, err := runLauncherVerb(scope, []string{"rm", "Editor"}); code != 1 || err == nil {
		t.Fatalf("rm ambiguous label = %d, %v, want error listing ids", code, err)
	}
	// The id always removes exactly one.
	launchers, _ := readDoc(t, scope.path)["launchers"].([]any)
	id, _ := launchers[0].(map[string]any)["id"].(string)
	if code, err := runLauncherVerb(scope, []string{"rm", id}); code != 0 || err != nil {
		t.Fatalf("rm by id: %d, %v", code, err)
	}
	if launchers, _ = readDoc(t, scope.path)["launchers"].([]any); len(launchers) != 1 {
		t.Errorf("launchers after rm by id = %v, want 1 entry", launchers)
	}
}

func TestCarryOverVerbs(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	path := projectConfigJSONPath(proj.ID)
	add := func(args parsedArgs) (int, error) { return projectCarryOverVerb(proj, projectConfigScope(proj), args) }
	pos := func(p ...string) parsedArgs {
		return parsedArgs{positionals: append([]string{"carryover"}, p...), bools: map[string]bool{}}
	}
	if code, err := add(pos("add", "./.env/")); code != 0 || err != nil {
		t.Fatalf("add .env: %d, %v", code, err)
	}
	entries, _ := readDoc(t, path)["carryOver"].([]any)
	entry, _ := entries[0].(map[string]any)
	// ./-prefix and trailing slash folded, and symlink is the default mode.
	if entry["path"] != ".env" || entry["mode"] != "symlink" {
		t.Errorf("entry = %v, want .env/symlink", entry)
	}
	// Re-adding upserts the mode instead of duplicating.
	withCopy := pos("add", ".env")
	withCopy.bools["copy"] = true
	if code, err := add(withCopy); code != 0 || err != nil {
		t.Fatalf("re-add .env --copy: %d, %v", code, err)
	}
	entries, _ = readDoc(t, path)["carryOver"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries after upsert = %v, want 1", entries)
	}
	if entry, _ = entries[0].(map[string]any); entry["mode"] != "copy" {
		t.Errorf("mode after upsert = %v, want copy", entry["mode"])
	}
	// Absolute paths inside the project fold to relative. Escapes
	// are refused.
	if code, err := add(pos("add", proj.Path+"/config/local.json")); code != 0 || err != nil {
		t.Fatalf("add absolute-inside: %d, %v", code, err)
	}
	entries, _ = readDoc(t, path)["carryOver"].([]any)
	if entry, _ = entries[1].(map[string]any); entry["path"] != "config/local.json" {
		t.Errorf("absolute path folded to %v, want config/local.json", entry["path"])
	}
	for _, bad := range []string{"../outside", "/etc/passwd", "a/../../b"} {
		if code, err := add(pos("add", bad)); code != 2 || err == nil {
			t.Errorf("add %q = %d, %v, want usage error", bad, code, err)
		}
	}
	if code, err := add(pos("rm", ".env")); code != 0 || err != nil {
		t.Fatalf("rm .env: %d, %v", code, err)
	}
	if code, err := add(pos("rm", ".env")); code != 1 || err == nil {
		t.Errorf("rm missing = %d, %v, want not-found error", code, err)
	}
	// Removing the last entry omits the key.
	if code, err := add(pos("rm", "config/local.json")); code != 0 || err != nil {
		t.Fatalf("rm last: %d, %v", code, err)
	}
	if _, ok := readDoc(t, path)["carryOver"]; ok {
		t.Error("carryOver key still present after removing the last entry")
	}
}

func TestProjectConfigRefusesBranchlessWrite(t *testing.T) {
	sandboxDataDir(t)
	// Unseeded project in a non-repo dir: the backfill resolves nothing,
	// so a write that would land a defaultBranch-less document (which
	// the app's schema read throws on) must be refused, not written.
	proj := testProject(t)
	if code, err := runConfigSet(projectConfigScope(proj), "portBase", "5170"); code != 1 || err == nil {
		t.Errorf("branchless set = %d, %v, want refusal", code, err)
	}
	if _, err := os.Stat(projectConfigJSONPath(proj.ID)); err == nil {
		t.Error("refused write still created project.json")
	}
}

func TestUpdateRefusesMalformedFile(t *testing.T) {
	sandboxDataDir(t)
	broken := `{"theme": "dark",}` // trailing comma
	if err := os.WriteFile(configJSONPath(), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigSet(globalConfigScope(), "portPool", "on"); code != 1 || err == nil {
		t.Errorf("set on malformed file = %d, %v, want error", code, err)
	}
	raw, err := os.ReadFile(configJSONPath())
	if err != nil || string(raw) != broken {
		t.Errorf("malformed file was rewritten to %q", raw)
	}
}

// An unreadable file is not an absent one: merging into the {} start
// would rewrite config.json with only the field being set.
func TestUpdateRefusesUnreadableFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads through mode 0000")
	}
	sandboxDataDir(t)
	kept := `{"theme": "dark"}`
	if err := os.WriteFile(configJSONPath(), []byte(kept), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(configJSONPath(), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(configJSONPath(), 0o644) })
	if code, err := runConfigSet(globalConfigScope(), "portPool", "on"); code != 1 || err == nil {
		t.Errorf("set on unreadable file = %d, %v, want error", code, err)
	}
	if err := os.Chmod(configJSONPath(), 0o644); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(configJSONPath()); err != nil || string(raw) != kept {
		t.Errorf("unreadable file was rewritten to %q", raw)
	}
}

func TestNoopMutationSkipsWrite(t *testing.T) {
	sandboxDataDir(t)
	// Unsetting an absent key must not conjure the file into existence.
	if code, err := runConfigUnset(globalConfigScope(), "launchScripts"); code != 0 || err != nil {
		t.Fatalf("noop unset: %d, %v", code, err)
	}
	if _, err := os.Stat(configJSONPath()); err == nil {
		t.Error("noop unset created config.json")
	}
}

func TestLauncherRmIdlessEntry(t *testing.T) {
	sandboxDataDir(t)
	// Hand-written entries without ids: removal must be positional, not
	// a nil == nil id sweep that deletes every id-less sibling.
	seed := `{"launchers": [{"label": "A", "command": "a"}, {"label": "B", "command": "b"}]}` + "\n"
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runLauncherVerb(globalConfigScope(), []string{"rm", "A"}); code != 0 || err != nil {
		t.Fatalf("rm A: %d, %v", code, err)
	}
	launchers, _ := readDoc(t, configJSONPath())["launchers"].([]any)
	if len(launchers) != 1 {
		t.Fatalf("launchers after rm = %v, want B alone", launchers)
	}
	if label, _ := launchers[0].(map[string]any)["label"].(string); label != "B" {
		t.Errorf("survivor = %v, want B", label)
	}
}

func TestCarryOverPathCanonicalization(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	pos := func(p ...string) parsedArgs {
		return parsedArgs{positionals: append([]string{"carryover"}, p...), bools: map[string]bool{}}
	}
	scope := projectConfigScope(proj)
	if code, err := projectCarryOverVerb(proj, scope, pos("add", ".env")); code != 0 || err != nil {
		t.Fatalf("add .env: %d, %v", code, err)
	}
	// Alternate spellings of the same path upsert instead of duplicating.
	for _, spelling := range []string{"././.env", ".//.env", "./.env"} {
		if code, err := projectCarryOverVerb(proj, scope, pos("add", spelling)); code != 0 || err != nil {
			t.Fatalf("add %q: %d, %v", spelling, code, err)
		}
	}
	entries, _ := readDoc(t, projectConfigJSONPath(proj.ID))["carryOver"].([]any)
	if len(entries) != 1 {
		t.Errorf("entries = %v, want a single canonical .env", entries)
	}
}

func TestConfigWriteValidates(t *testing.T) {
	sandboxDataDir(t)
	scope := globalConfigScope()
	if code, _ := runConfigWrite(scope, `{"launchScripts": "nope"}`); code != 1 {
		t.Errorf("mistyped launchScripts accepted: code %d", code)
	}
	if code, _ := runConfigWrite(scope, `not json`); code != 2 {
		t.Errorf("malformed data accepted: code %d", code)
	}
	if code, err := runConfigWrite(scope, `{"launchScripts": false, "portPool": true}`); code != 0 || err != nil {
		t.Fatalf("valid write: %d, %v", code, err)
	}
	doc := readDoc(t, scope.path)
	if doc["launchScripts"] != false || doc["portPool"] != true {
		t.Errorf("written doc = %v", doc)
	}
	// A JSON null decodes to a nil map. It must be refused, not treated
	// as {} and used to wipe the file.
	if code, _ := runConfigWrite(scope, `null`); code != 2 {
		t.Errorf("write null accepted: code %d", code)
	}
	// The project registry marks defaultBranch required: a payload
	// without it must be refused, not written. Same for wrong-typed
	// containers and invalid array elements, which the app's schema
	// would reject wholesale on read.
	proj := testProject(t)
	for _, data := range []string{
		`{}`,
		`{"defaultBranch": "  "}`,
		`{"defaultBranch": "main", "scripts": "oops"}`,
		`{"defaultBranch": "main", "launchers": [{"label": "x"}]}`,
		`{"defaultBranch": "main", "carryOver": [{"path": "../out", "mode": "copy"}]}`,
	} {
		if code, _ := runConfigWrite(projectConfigScope(proj), data); code != 1 {
			t.Errorf("write %s accepted despite invalid payload: code %d", data, code)
		}
	}
	if _, err := os.Stat(projectConfigJSONPath(proj.ID)); err == nil {
		t.Error("refused write still created project.json")
	}
}

func TestConfigWriteMergesUnknownKeys(t *testing.T) {
	sandboxDataDir(t)
	scope := globalConfigScope()
	// futureSetting is a key only a newer build models, and theme and
	// doubutsu are legacy client keys the registry no longer models.
	// The app's write payload schema strips all of them, so only the
	// merge keeps them alive across a device-only write.
	seed := `{"launchScripts": false, "theme": "dark", "doubutsu": false, "futureSetting": {"nested": "keep"}}` + "\n"
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigWrite(scope, `{"portPool": true}`); code != 0 || err != nil {
		t.Fatalf("write: %d, %v", code, err)
	}
	doc := readDoc(t, scope.path)
	future, _ := doc["futureSetting"].(map[string]any)
	if future == nil || future["nested"] != "keep" {
		t.Errorf("futureSetting after write = %v, want it untouched", doc["futureSetting"])
	}
	if doc["theme"] != "dark" || doc["doubutsu"] != false {
		t.Errorf("legacy client keys after write = %v/%v, want them untouched", doc["theme"], doc["doubutsu"])
	}
	if doc["portPool"] != true {
		t.Errorf("portPool = %v, want true", doc["portPool"])
	}
	// Omitting a registry key still clears it: that is how the app
	// resets a field to its default.
	if _, ok := doc["launchScripts"]; ok {
		t.Errorf("launchScripts = %v, want cleared by the omitting payload", doc["launchScripts"])
	}
}

func TestProjectConfigWriteMergesNestedAndReplacesArrays(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	scope := projectConfigScope(proj)
	seed := `{"defaultBranch": "main", "futureTop": "keep",` +
		`"scripts": {"setup": "old", "teardown": "bye", "futureScript": "keep"},` +
		`"carryOver": [{"path": ".env", "mode": "copy"}, {"path": ".envrc", "mode": "copy"}]}` + "\n"
	if err := os.WriteFile(scope.path, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	data := `{"defaultBranch": "main", "scripts": {"setup": "new"},` +
		`"carryOver": [{"path": ".env", "mode": "symlink"}]}`
	if code, err := runConfigWrite(scope, data); code != 0 || err != nil {
		t.Fatalf("write: %d, %v", code, err)
	}
	doc := readDoc(t, scope.path)
	if doc["futureTop"] != "keep" {
		t.Errorf("futureTop = %v, want it untouched", doc["futureTop"])
	}
	scripts, _ := doc["scripts"].(map[string]any)
	if scripts == nil || scripts["futureScript"] != "keep" {
		t.Errorf("scripts = %v, want futureScript untouched", doc["scripts"])
	}
	if scripts["setup"] != "new" {
		t.Errorf("scripts.setup = %v, want new", scripts["setup"])
	}
	// Nested registry keys clear the same way top-level ones do.
	if _, ok := scripts["teardown"]; ok {
		t.Errorf("scripts.teardown = %v, want cleared", scripts["teardown"])
	}
	// Arrays replace wholesale rather than merging element by element.
	entries, _ := doc["carryOver"].([]any)
	if len(entries) != 1 {
		t.Fatalf("carryOver = %v, want the payload's single entry", entries)
	}
	if entry, _ := entries[0].(map[string]any); entry["mode"] != "symlink" {
		t.Errorf("carryOver[0] = %v, want the payload's symlink entry", entries[0])
	}
}

// A hand-edited file can hold a scalar where the registry expects an
// object. The merge still has to land the registry exactly as the
// payload asks, or the write succeeds and leaves a document the app's
// schema rejects on every read.
func TestConfigWriteRepairsWrongShapedRegistryValues(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	scope := projectConfigScope(proj)
	seed := `{"defaultBranch": "main", "futureTop": "keep",` +
		`"scripts": "oops", "launchers": 3}` + "\n"
	if err := os.WriteFile(scope.path, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	// The clear case: the payload omits scripts.setup and
	// scripts.teardown, so the wrong-shaped parent goes with them.
	if code, err := runConfigWrite(scope, `{"defaultBranch": "dev"}`); code != 0 || err != nil {
		t.Fatalf("write: %d, %v", code, err)
	}
	doc := readDoc(t, scope.path)
	if _, ok := doc["scripts"]; ok {
		t.Errorf("scripts = %v, want cleared even though it held a string", doc["scripts"])
	}
	if _, ok := doc["launchers"]; ok {
		t.Errorf("launchers = %v, want cleared", doc["launchers"])
	}
	if doc["defaultBranch"] != "dev" {
		t.Errorf("defaultBranch = %v, want dev", doc["defaultBranch"])
	}
	// Dropping the wrong-shaped parent costs nothing else: unknown keys
	// elsewhere in the file are still preserved.
	if doc["futureTop"] != "keep" {
		t.Errorf("futureTop = %v, want it untouched", doc["futureTop"])
	}
}

func TestConfigWriteSetsThroughWrongShapedParent(t *testing.T) {
	sandboxDataDir(t)
	proj := seededProject(t)
	scope := projectConfigScope(proj)
	for _, seeded := range []string{`"oops"`, `3`, `null`, `["oops"]`} {
		seed := `{"defaultBranch": "main", "scripts": ` + seeded + `}` + "\n"
		if err := os.WriteFile(scope.path, []byte(seed), 0o644); err != nil {
			t.Fatal(err)
		}
		data := `{"defaultBranch": "main", "scripts": {"setup": "new"}}`
		if code, err := runConfigWrite(scope, data); code != 0 || err != nil {
			t.Fatalf("write over %s: %d, %v", seeded, code, err)
		}
		scripts, _ := readDoc(t, scope.path)["scripts"].(map[string]any)
		if scripts == nil || scripts["setup"] != "new" {
			t.Errorf("scripts over %s = %v, want the payload's object", seeded, scripts)
		}
	}
}

// --- the schema marker ---

func TestConfigWriteStampsSchemaVersion(t *testing.T) {
	sandboxDataDir(t)
	if code, err := runConfigSet(globalConfigScope(), "launchScripts", "false"); code != 0 || err != nil {
		t.Fatalf("set launchScripts false: %d, %v", code, err)
	}
	if got := readDoc(t, configJSONPath())["schemaVersion"]; got != json.Number("1") {
		t.Errorf("config.json schemaVersion = %v, want 1", got)
	}
	proj := seededProject(t)
	if got := readDoc(t, projectConfigJSONPath(proj.ID))["schemaVersion"]; got != json.Number("1") {
		t.Errorf("project.json schemaVersion = %v, want 1", got)
	}
}

// A marker from a build that doesn't exist yet is read, not refused,
// and the rest of the document survives the write that stamps it back
// down to what this build actually produces.
func TestConfigToleratesNewerSchemaVersion(t *testing.T) {
	sandboxDataDir(t)
	seed := `{"schemaVersion": 99, "theme": "dark", "futureKey": "kept"}` + "\n"
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigSet(globalConfigScope(), "portPool", "on"); code != 0 || err != nil {
		t.Fatalf("set against a newer config: %d, %v", code, err)
	}
	doc := readDoc(t, configJSONPath())
	if doc["theme"] != "dark" || doc["futureKey"] != "kept" {
		t.Errorf("newer config lost fields: %v", doc)
	}
	if got := doc["schemaVersion"]; got != json.Number("1") {
		t.Errorf("schemaVersion = %v, want this build's 1", got)
	}
}

// The marker rides on writes that were going to happen anyway. A
// mutation that changes nothing still touches nothing, so an untouched
// file keeps its mtime and the watcher stays quiet.
func TestNoopMutationDoesNotStampSchemaVersion(t *testing.T) {
	sandboxDataDir(t)
	seed := `{"launchScripts": false}` + "\n"
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigSet(globalConfigScope(), "launchScripts", "false"); code != 0 || err != nil {
		t.Fatalf("noop set: %d, %v", code, err)
	}
	if raw, err := os.ReadFile(configJSONPath()); err != nil || string(raw) != seed {
		t.Errorf("noop set rewrote config.json to %q", raw)
	}
}

// list/get on a corrupt file must error, not print every key as its
// default with exit 0: "deleteBranchOnRemove  true (default)" over an
// explicitly written false is the destructive kind of wrong.
func TestListAndGetRefuseMalformedFile(t *testing.T) {
	sandboxDataDir(t)
	seed := `{"deleteBranchOnRemove": false,}` // trailing comma
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigList(globalConfigScope()); code != 1 || err == nil {
		t.Errorf("list on malformed file = %d, %v, want error", code, err)
	}
	if code, err := runConfigGet(globalConfigScope(), "deleteBranchOnRemove"); code != 1 || err == nil {
		t.Errorf("get on malformed file = %d, %v, want error", code, err)
	}
}

// The editor seed is a real document, marker included, so a file
// created by `sm config edit` doesn't read as pre-schema forever.
// jsonMode returns right after seeding, so only the seed is covered
// here -- the editor branch needs an interactive terminal.
func TestEditSeedStampsSchemaVersion(t *testing.T) {
	sandboxDataDir(t)
	jsonModeSaved := jsonMode
	jsonMode = true
	t.Cleanup(func() { jsonMode = jsonModeSaved })
	if code, err := openConfigFileInEditor(configJSONPath()); code != 0 || err != nil {
		t.Fatalf("edit seeding = %d, %v", code, err)
	}
	if got := readDoc(t, configJSONPath())["schemaVersion"]; got != json.Number("1") {
		t.Errorf("seeded schemaVersion = %v (%T), want 1", got, got)
	}
}
