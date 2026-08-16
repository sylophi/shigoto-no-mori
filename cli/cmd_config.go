package main

// sm config <list|get|set|unset|edit> -- global settings from the
// terminal, plus the shared key engine `sm projects config` reuses for
// its per-project verbs (cmd_project.go). Keys are the JSON field
// names (dotted for nesting: scripts.setup), values are validated
// against the same shapes the app's zod schemas enforce, and writes
// are read-modify-write under the file lock so nothing else in the
// document is disturbed. Serialization follows the app's authority
// (SettingsForm.toConfig): a value equal to its default is stored by
// deleting the key, so config files stay tidy no matter which surface
// wrote them.
//
// `write --data '<json>'` is plumbing for the app: the delegated
// globalConfig:write / shigomori:write IPC handlers replace the whole
// document through it so both surfaces run the same engine.

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type configKind int

const (
	boolKind configKind = iota
	stringKind
	enumKind
	intKind
	// Arrays the CLI shows but doesn't set key-by-value; point users at
	// `edit` or the app.
	jsonKind
)

type configKey struct {
	// Dotted path into the JSON document, verbatim field names.
	name string
	kind configKind
	enum []string
	// Effective value when the key is absent; nil = genuinely unset.
	// Doubles as the normalize-on-write target: setting a key to its
	// default deletes it instead, matching the app's omit-on-default
	// serialization.
	def  any
	desc string
}

// Mirrors GlobalConfigSchema (shared/schemas/config.ts); defaults from
// SettingsForm.fromConfig, the serialization authority.
var globalConfigKeys = []configKey{
	{name: "theme", kind: enumKind, enum: []string{"light", "dark", "system"}, def: "system",
		desc: "UI theme"},
	{name: "doubutsu", kind: boolKind, def: true,
		desc: "Animal Crossing visual mode"},
	{name: "launchScripts", kind: boolKind, def: true,
		desc: "Show package scripts in the Launch section"},
	{name: "deleteBranchOnRemove", kind: boolKind, def: true,
		desc: "Delete the branch when removing its worktree"},
	{name: "autoPopulateInstall", kind: boolKind, def: false,
		desc: "Seed new projects' setup script with `<pm> install`"},
	{name: "portPool", kind: boolKind, def: false,
		desc: "Provision/release port-pool ports with worktrees"},
	{name: "githubCli", kind: boolKind, def: true,
		desc: "GitHub CLI integration"},
	{name: "launchers", kind: jsonKind, def: []any{},
		desc: "Global custom launchers (via edit or the app)"},
	{name: "hiddenLaunchers", kind: jsonKind, def: []any{},
		desc: "Hidden launcher ids (via edit or the app)"},
}

// Mirrors ShigomoriConfigSchema. defaultBranch is required there -- a
// document without it reads as absent on both engines -- so set/unset
// guard it specially (projectConfig verbs in cmd_project.go).
var projectConfigKeys = []configKey{
	{name: "defaultBranch", kind: stringKind,
		desc: "Branch new worktrees fork from (required)"},
	{name: "scripts.setup", kind: stringKind,
		desc: "Runs after creating a worktree"},
	{name: "scripts.teardown", kind: stringKind,
		desc: "Runs before removing a worktree"},
	{name: "worktreeLayout", kind: enumKind, enum: []string{"managed-root", "in-project", "custom"},
		def:  "managed-root",
		desc: "Where managed worktrees live"},
	{name: "customWorktreePath", kind: stringKind,
		desc: "Absolute base dir for the custom layout"},
	{name: "useWorktreeInclude", kind: boolKind, def: true,
		desc: "Honor the repo's .worktreeinclude file"},
	{name: "portBase", kind: intKind,
		desc: "port-pool base port"},
	{name: "lastMergeMethod", kind: enumKind, enum: []string{"merge", "squash", "rebase"},
		desc: "Preferred PR merge method"},
	{name: "carryOver", kind: jsonKind, def: []any{},
		desc: "Files carried into new worktrees (via edit or the app)"},
	{name: "launchers", kind: jsonKind, def: []any{},
		desc: "Per-project launchers (via edit or the app)"},
}

func lookupConfigKey(keys []configKey, name string) (configKey, error) {
	names := make([]string, len(keys))
	for i, key := range keys {
		if key.name == name {
			return key, nil
		}
		names[i] = key.name
	}
	return configKey{}, usageErrf("Unknown key %q. Keys: %s.", name, strings.Join(names, ", "))
}

// The string forms git accepts for boolean config, normalized to a JSON
// bool; enums and ints validated to the schema's constraints.
func parseConfigValue(key configKey, raw string) (any, error) {
	switch key.kind {
	case boolKind:
		switch strings.ToLower(raw) {
		case "true", "on", "yes", "1":
			return true, nil
		case "false", "off", "no", "0":
			return false, nil
		}
		return nil, usageErrf("%s is a boolean; use true or false.", key.name)
	case enumKind:
		for _, v := range key.enum {
			if raw == v {
				return raw, nil
			}
		}
		return nil, usageErrf("%s must be one of: %s.", key.name, strings.Join(key.enum, ", "))
	case intKind:
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return nil, usageErrf("%s must be a positive integer.", key.name)
		}
		return n, nil
	default:
		return raw, nil
	}
}

func equalsConfigDefault(key configKey, value any) bool {
	switch def := key.def.(type) {
	case bool:
		b, ok := value.(bool)
		return ok && b == def
	case string:
		s, ok := value.(string)
		return ok && s == def
	}
	return false
}

func renderConfigValue(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case json.Number:
		return v.String()
	case int:
		return strconv.Itoa(v)
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

// --- raw JSON documents with dotted-path access ---

// Numbers decode as json.Number so an untouched value re-serializes
// byte-identical instead of round-tripping through float64.
func decodeConfigDoc(raw []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	if doc == nil {
		doc = map[string]any{}
	}
	return doc, nil
}

// Missing or malformed files read as empty, same as the app's
// null-tolerant readers; the following write replaces them.
func readConfigDoc(path string) map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	doc, err := decodeConfigDoc(raw)
	if err != nil {
		return map[string]any{}
	}
	return doc
}

// Read-modify-write under the sibling .lock (withFileLock), so two CLI
// invocations can't clobber each other's fields.
func updateConfigDoc(path string, fn func(doc map[string]any) error) error {
	return withFileLock(path, func() error {
		doc := readConfigDoc(path)
		if err := fn(doc); err != nil {
			return err
		}
		return atomicWriteJSON(path, doc)
	})
}

func configDocGet(doc map[string]any, name string) (any, bool) {
	var cur any = doc
	for _, part := range strings.Split(name, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[part]; !ok {
			return nil, false
		}
	}
	return cur, true
}

func configDocSet(doc map[string]any, name string, value any) {
	parts := strings.Split(name, ".")
	m := doc
	for _, part := range parts[:len(parts)-1] {
		child, ok := m[part].(map[string]any)
		if !ok {
			child = map[string]any{}
			m[part] = child
		}
		m = child
	}
	m[parts[len(parts)-1]] = value
}

func configDocDelete(doc map[string]any, name string) {
	parts := strings.Split(name, ".")
	parents := []map[string]any{doc}
	m := doc
	for _, part := range parts[:len(parts)-1] {
		child, ok := m[part].(map[string]any)
		if !ok {
			return
		}
		parents = append(parents, child)
		m = child
	}
	delete(m, parts[len(parts)-1])
	// Prune emptied parents so clearing scripts.teardown doesn't leave
	// `"scripts": {}` behind.
	for i := len(parents) - 1; i > 0; i-- {
		if len(parents[i]) != 0 {
			break
		}
		delete(parents[i-1], parts[i-1])
	}
}

// Shape check for `write --data` payloads: every registry key that is
// present must carry its schema'd type, so engine drift fails loudly
// here instead of surfacing as a document zod later rejects wholesale.
// Unknown keys pass through untouched (forward compatibility).
func validateConfigDoc(keys []configKey, doc map[string]any) error {
	for _, key := range keys {
		value, ok := configDocGet(doc, key.name)
		if !ok {
			continue
		}
		switch key.kind {
		case boolKind:
			if _, ok := value.(bool); !ok {
				return errf("%s must be a boolean.", key.name)
			}
		case stringKind:
			if _, ok := value.(string); !ok {
				return errf("%s must be a string.", key.name)
			}
		case enumKind:
			s, ok := value.(string)
			if !ok {
				return errf("%s must be a string.", key.name)
			}
			if _, err := parseConfigValue(key, s); err != nil {
				return errf("%s must be one of: %s.", key.name, strings.Join(key.enum, ", "))
			}
		case intKind:
			num, ok := value.(json.Number)
			if !ok {
				return errf("%s must be a positive integer.", key.name)
			}
			if n, err := num.Int64(); err != nil || n <= 0 {
				return errf("%s must be a positive integer.", key.name)
			}
		case jsonKind:
			if _, ok := value.([]any); !ok {
				return errf("%s must be an array.", key.name)
			}
		}
	}
	return nil
}

// --- shared verb bodies (global and projects config) ---

type configListEntry struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
	Set   bool   `json:"set"`
}

func configListEntries(keys []configKey, doc map[string]any) []configListEntry {
	entries := make([]configListEntry, len(keys))
	for i, key := range keys {
		value, set := configDocGet(doc, key.name)
		if !set {
			value = key.def
		}
		entries[i] = configListEntry{Key: key.name, Value: value, Set: set}
	}
	return entries
}

func renderConfigList(keys []configKey, doc map[string]any) string {
	rows := make([][]string, len(keys))
	for i, key := range keys {
		value, set := configDocGet(doc, key.name)
		if !set {
			value = key.def
		}
		cell := renderConfigValue(value)
		if !set {
			// The marker is text, not just dimming: meaning must survive
			// pipes and --json-less scripting.
			marker := "(default)"
			if key.def == nil {
				marker = "(unset)"
			}
			if cell == "" {
				cell = dimOut(marker)
			} else {
				cell += " " + dimOut(marker)
			}
		}
		rows[i] = []string{key.name, cell, dimOut(key.desc)}
	}
	return renderTable([]string{"KEY", "VALUE", "DESCRIPTION"}, rows)
}

// get prints the effective value bare on stdout (nothing when the key
// is unset and has no default), so command substitution stays clean.
func runConfigGet(keys []configKey, doc map[string]any, name string, extra map[string]any) (int, error) {
	key, err := lookupConfigKey(keys, name)
	if err != nil {
		return exitCodeOf(err), err
	}
	value, set := configDocGet(doc, key.name)
	if !set {
		value = key.def
	}
	if jsonMode {
		result := map[string]any{"ok": true, "key": key.name, "value": value, "set": set}
		for k, v := range extra {
			result[k] = v
		}
		emit(result)
		return 0, nil
	}
	if value != nil {
		out(renderConfigValue(value))
	}
	return 0, nil
}

// --- sm config (global) ---

func configJSONPath() string {
	return filepath.Join(shigomoriRoot(), "config.json")
}

func cmdConfigGlobal(_ cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"data": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	sub := ""
	if len(parsed.positionals) > 0 {
		sub = parsed.positionals[0]
	}
	wantPositionals := func(n int, usage string) error {
		if len(parsed.positionals) != n {
			return usageErrf("Usage: %s config %s", binaryName, usage)
		}
		return nil
	}
	switch sub {
	case "":
		out(configHelpText())
		return 0, nil
	case "list":
		doc := readConfigDoc(configJSONPath())
		if jsonMode {
			emit(map[string]any{"ok": true, "settings": configListEntries(globalConfigKeys, doc)})
			return 0, nil
		}
		out(renderConfigList(globalConfigKeys, doc))
		return 0, nil
	case "get":
		if err := wantPositionals(2, "get <key>"); err != nil {
			return 2, err
		}
		return runConfigGet(globalConfigKeys, readConfigDoc(configJSONPath()), parsed.positionals[1], nil)
	case "set":
		if err := wantPositionals(3, "set <key> <value>"); err != nil {
			return 2, err
		}
		return globalConfigSet(parsed.positionals[1], parsed.positionals[2])
	case "unset":
		if err := wantPositionals(2, "unset <key>"); err != nil {
			return 2, err
		}
		return globalConfigUnset(parsed.positionals[1])
	case "edit":
		return openConfigFileInEditor(configJSONPath())
	case "write":
		// App plumbing: whole-document replace, mirroring the TS
		// engine's writeGlobalConfig (zod already stripped/validated on
		// the way in; the shape check guards engine drift).
		return configWriteDoc(configJSONPath(), globalConfigKeys, parsed.strings["data"], nil)
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s config <list|get|set|unset|edit> [args]",
			sub, binaryName)
	}
}

func globalConfigSet(name, raw string) (int, error) {
	key, err := lookupConfigKey(globalConfigKeys, name)
	if err != nil {
		return exitCodeOf(err), err
	}
	if key.kind == jsonKind {
		return 2, usageErrf("%s is structured; use `%s config edit` or the app.", key.name, binaryName)
	}
	value, err := parseConfigValue(key, raw)
	if err != nil {
		return exitCodeOf(err), err
	}
	err = updateConfigDoc(configJSONPath(), func(doc map[string]any) error {
		if equalsConfigDefault(key, value) {
			configDocDelete(doc, key.name)
		} else {
			configDocSet(doc, key.name, value)
		}
		return nil
	})
	if err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "key": key.name, "value": value})
	} else {
		out(greenOut("set " + key.name + " = " + renderConfigValue(value)))
	}
	return 0, nil
}

func globalConfigUnset(name string) (int, error) {
	key, err := lookupConfigKey(globalConfigKeys, name)
	if err != nil {
		return exitCodeOf(err), err
	}
	err = updateConfigDoc(configJSONPath(), func(doc map[string]any) error {
		configDocDelete(doc, key.name)
		return nil
	})
	if err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "key": key.name})
	} else {
		suffix := ""
		if key.def != nil {
			suffix = " (default: " + renderConfigValue(key.def) + ")"
		}
		out(greenOut("unset " + key.name + suffix))
	}
	return 0, nil
}

// Whole-document replace for `write --data`, shared by both scopes.
// extraCheck runs on the decoded document before the write (project
// config's defaultBranch requirement).
func configWriteDoc(path string, keys []configKey, data string, extraCheck func(doc map[string]any) error) (int, error) {
	if data == "" {
		return 2, usageErrf("write requires --data '<json>'.")
	}
	doc, err := decodeConfigDoc([]byte(data))
	if err != nil {
		return 2, usageErrf("--data must be a JSON object: %v", err)
	}
	if err := validateConfigDoc(keys, doc); err != nil {
		return 1, err
	}
	if extraCheck != nil {
		if err := extraCheck(doc); err != nil {
			return exitCodeOf(err), err
		}
	}
	err = withFileLock(path, func() error {
		return atomicWriteJSON(path, doc)
	})
	if err != nil {
		return 1, err
	}
	emit(map[string]any{"ok": true})
	return 0, nil
}

// Opens a config file in $VISUAL/$EDITOR in an interactive terminal,
// the OS opener otherwise; --json (and editor-less non-darwin) just
// reports the path. Seeds an empty document so a save round-trips.
func openConfigFileInEditor(path string) (int, error) {
	if _, err := os.Stat(path); err != nil {
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if writeErr := os.WriteFile(path, []byte("{}\n"), 0o644); writeErr != nil {
			return 1, errf("Couldn't create %s: %v", path, writeErr)
		}
	}
	if jsonMode {
		emit(map[string]any{"path": path})
		return 0, nil
	}
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor != "" && interactiveStdio() {
		cmd := exec.Command("/bin/sh", "-c", editor+" "+shellQuote(path))
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return 1, errf("%s failed: %v", editor, err)
		}
		return 0, nil
	}
	if runtime.GOOS == "darwin" {
		if err := exec.Command("open", path).Run(); err != nil {
			return 1, errf("Couldn't open %s: %v", path, err)
		}
		out("opened " + path)
		return 0, nil
	}
	out(path)
	return 0, nil
}
