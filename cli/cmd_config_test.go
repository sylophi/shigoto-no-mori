package main

// Tests for the config key engine (cmd_config.go) and the project
// config verbs built on it: value parsing, omit-on-default
// normalization, dotted-path nesting with parent pruning, preservation
// of keys the CLI doesn't model, and the guards around the required
// defaultBranch. Everything runs against a temp SHIGOMORI_ROOT.

import (
	"os"
	"testing"
)

func sandboxConfigRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("SHIGOMORI_ROOT", root)
	saved := cachedRoot
	cachedRoot = ""
	t.Cleanup(func() { cachedRoot = saved })
	initRoot()
	return root
}

// A registered-looking project whose path is not a git repo, so
// defaultBranch backfill resolves to nothing and stays out of the way.
func testProject(t *testing.T) project {
	t.Helper()
	return project{ID: "TESTPROJECT", Name: "fox", Path: t.TempDir()}
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
	key := configKey{name: "doubutsu", kind: boolKind}
	for raw, want := range map[string]bool{
		"true": true, "on": true, "yes": true, "1": true, "TRUE": true,
		"false": false, "off": false, "no": false, "0": false,
	} {
		got, err := parseConfigValue(key, raw)
		if err != nil || got != want {
			t.Errorf("parse %q = %v, %v; want %v", raw, got, err, want)
		}
	}
	if _, err := parseConfigValue(key, "maybe"); err == nil {
		t.Error("parse \"maybe\" succeeded; want error")
	}
}

func TestParseConfigValueEnumAndInt(t *testing.T) {
	theme := configKey{name: "theme", kind: enumKind, enum: []string{"light", "dark", "system"}}
	if got, err := parseConfigValue(theme, "dark"); err != nil || got != "dark" {
		t.Errorf("parse dark = %v, %v", got, err)
	}
	if _, err := parseConfigValue(theme, "solarized"); err == nil {
		t.Error("parse solarized succeeded; want error")
	}
	portBase := configKey{name: "portBase", kind: intKind}
	if got, err := parseConfigValue(portBase, "5170"); err != nil || got != 5170 {
		t.Errorf("parse 5170 = %v, %v", got, err)
	}
	for _, raw := range []string{"0", "-3", "many"} {
		if _, err := parseConfigValue(portBase, raw); err == nil {
			t.Errorf("parse %q succeeded; want error", raw)
		}
	}
}

func TestGlobalConfigSetNormalizesDefaults(t *testing.T) {
	sandboxConfigRoot(t)
	if code, err := runConfigSet(globalConfigScope(), "theme", "dark"); code != 0 || err != nil {
		t.Fatalf("set theme dark: %d, %v", code, err)
	}
	doc := readDoc(t, configJSONPath())
	if doc["theme"] != "dark" {
		t.Errorf("theme = %v, want dark", doc["theme"])
	}
	// Setting the default removes the key, matching the app's
	// omit-on-default serialization.
	if code, err := runConfigSet(globalConfigScope(), "theme", "system"); code != 0 || err != nil {
		t.Fatalf("set theme system: %d, %v", code, err)
	}
	if _, ok := readDoc(t, configJSONPath())["theme"]; ok {
		t.Error("theme still present after being set to its default")
	}
	if code, err := runConfigSet(globalConfigScope(), "doubutsu", "off"); code != 0 || err != nil {
		t.Fatalf("set doubutsu off: %d, %v", code, err)
	}
	if got := readDoc(t, configJSONPath())["doubutsu"]; got != false {
		t.Errorf("doubutsu = %v, want false", got)
	}
	if code, err := runConfigUnset(globalConfigScope(), "doubutsu"); code != 0 || err != nil {
		t.Fatalf("unset doubutsu: %d, %v", code, err)
	}
	if _, ok := readDoc(t, configJSONPath())["doubutsu"]; ok {
		t.Error("doubutsu still present after unset")
	}
}

func TestGlobalConfigPreservesOtherKeys(t *testing.T) {
	sandboxConfigRoot(t)
	seed := `{"portPool": true, "futureKey": {"nested": 12345678901234567890}}` + "\n"
	if err := os.WriteFile(configJSONPath(), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, err := runConfigSet(globalConfigScope(), "theme", "light"); code != 0 || err != nil {
		t.Fatalf("set theme light: %d, %v", code, err)
	}
	doc := readDoc(t, configJSONPath())
	if doc["portPool"] != true {
		t.Errorf("portPool = %v, want true", doc["portPool"])
	}
	// Unknown keys survive verbatim, including numbers a float64
	// round-trip would mangle.
	nested, _ := configDocGet(doc, "futureKey.nested")
	if renderConfigValue(nested) != "12345678901234567890" {
		t.Errorf("futureKey.nested = %v, want the untouched literal", nested)
	}
}

func TestGlobalConfigSetRejects(t *testing.T) {
	sandboxConfigRoot(t)
	for name, raw := range map[string]string{
		"noSuchKey": "1",     // unknown key
		"doubutsu":  "maybe", // bad bool
		"theme":     "sepia", // bad enum
		"launchers": "[]",    // structured
	} {
		if code, err := runConfigSet(globalConfigScope(), name, raw); code != 2 || err == nil {
			t.Errorf("set %s %q = %d, %v; want usage error", name, raw, code, err)
		}
	}
}

func TestProjectConfigScriptsNesting(t *testing.T) {
	sandboxConfigRoot(t)
	proj := testProject(t)
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
	// "" clears, like the long-standing --setup '' behavior; the sibling
	// stays put.
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
	sandboxConfigRoot(t)
	proj := testProject(t)
	if code, err := runConfigSet(projectConfigScope(proj), "defaultBranch", ""); code != 2 || err == nil {
		t.Errorf("set defaultBranch \"\" = %d, %v; want usage error", code, err)
	}
	if code, err := runConfigUnset(projectConfigScope(proj), "defaultBranch"); code != 2 || err == nil {
		t.Errorf("unset defaultBranch = %d, %v; want usage error", code, err)
	}
	if code, err := runConfigSet(projectConfigScope(proj), "defaultBranch", "main"); code != 0 || err != nil {
		t.Fatalf("set defaultBranch main: %d, %v", code, err)
	}
	if got := readDoc(t, projectConfigJSONPath(proj.ID))["defaultBranch"]; got != "main" {
		t.Errorf("defaultBranch = %v, want main", got)
	}
}

func TestProjectConfigBoolAndPathKeys(t *testing.T) {
	sandboxConfigRoot(t)
	proj := testProject(t)
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
	sandboxConfigRoot(t)
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
		t.Errorf("rm Ghost = %d, %v; want not-found error", code, err)
	}
}

func TestLauncherRmAmbiguousLabel(t *testing.T) {
	sandboxConfigRoot(t)
	scope := globalConfigScope()
	for range 2 {
		if code, err := runLauncherVerb(scope, []string{"add", "Editor", "code ."}); code != 0 || err != nil {
			t.Fatalf("add Editor: %d, %v", code, err)
		}
	}
	if code, err := runLauncherVerb(scope, []string{"rm", "Editor"}); code != 1 || err == nil {
		t.Fatalf("rm ambiguous label = %d, %v; want error listing ids", code, err)
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
	sandboxConfigRoot(t)
	proj := testProject(t)
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
	// ./-prefix and trailing slash folded; symlink is the default mode.
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
	// Absolute paths inside the project fold to relative; escapes are
	// refused.
	if code, err := add(pos("add", proj.Path+"/config/local.json")); code != 0 || err != nil {
		t.Fatalf("add absolute-inside: %d, %v", code, err)
	}
	entries, _ = readDoc(t, path)["carryOver"].([]any)
	if entry, _ = entries[1].(map[string]any); entry["path"] != "config/local.json" {
		t.Errorf("absolute path folded to %v, want config/local.json", entry["path"])
	}
	for _, bad := range []string{"../outside", "/etc/passwd", "a/../../b"} {
		if code, err := add(pos("add", bad)); code != 2 || err == nil {
			t.Errorf("add %q = %d, %v; want usage error", bad, code, err)
		}
	}
	if code, err := add(pos("rm", ".env")); code != 0 || err != nil {
		t.Fatalf("rm .env: %d, %v", code, err)
	}
	if code, err := add(pos("rm", ".env")); code != 1 || err == nil {
		t.Errorf("rm missing = %d, %v; want not-found error", code, err)
	}
	// Removing the last entry omits the key.
	if code, err := add(pos("rm", "config/local.json")); code != 0 || err != nil {
		t.Fatalf("rm last: %d, %v", code, err)
	}
	if _, ok := readDoc(t, path)["carryOver"]; ok {
		t.Error("carryOver key still present after removing the last entry")
	}
}

func TestConfigWriteValidates(t *testing.T) {
	sandboxConfigRoot(t)
	scope := globalConfigScope()
	if code, _ := runConfigWrite(scope, `{"doubutsu": "nope"}`); code != 1 {
		t.Errorf("mistyped doubutsu accepted: code %d", code)
	}
	if code, _ := runConfigWrite(scope, `not json`); code != 2 {
		t.Errorf("malformed data accepted: code %d", code)
	}
	if code, err := runConfigWrite(scope, `{"theme": "dark", "portPool": true}`); code != 0 || err != nil {
		t.Fatalf("valid write: %d, %v", code, err)
	}
	doc := readDoc(t, scope.path)
	if doc["theme"] != "dark" || doc["portPool"] != true {
		t.Errorf("written doc = %v", doc)
	}
	// The project registry marks defaultBranch required: a payload
	// without it must be refused, not written.
	proj := testProject(t)
	for _, data := range []string{`{}`, `{"defaultBranch": "  "}`} {
		if code, _ := runConfigWrite(projectConfigScope(proj), data); code != 1 {
			t.Errorf("write %s accepted despite missing defaultBranch: code %d", data, code)
		}
	}
	if _, err := os.Stat(projectConfigJSONPath(proj.ID)); err == nil {
		t.Error("refused write still created project.json")
	}
}
