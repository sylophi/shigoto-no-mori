package main

// sm config <list|get|set|unset|edit|launcher> -- global settings from
// the terminal, plus the shared key engine `sm projects config` reuses
// for its per-project verbs (cmd_project.go). Keys are the JSON field
// names (dotted for nesting: scripts.setup), values are validated
// against the same shapes the app's zod schemas enforce, and writes
// are read-modify-write under the file lock so nothing else in the
// document is disturbed. Serialization follows the app's authority
// (SettingsForm.toConfig): a value equal to its default is stored by
// deleting the key, so config files stay tidy no matter which surface
// wrote them.
//
// The two scopes differ only in what configDocScope models -- file
// path, output decoration, key registry, and write hooks -- so every
// verb body lives here once and cmd_project.go contributes hooks.
//
// `write --data '<json>'` is plumbing for the app: the delegated
// globalConfig:write / shigomori:write IPC handlers push whole
// documents through it so both surfaces run the same engine. Those
// writes merge into the file too, so a key only a newer version knows
// about survives an older build's save.

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type configKind int

const (
	boolKind configKind = iota
	stringKind
	enumKind
	intKind
	// Arrays the CLI shows but doesn't set key-by-value. Point users
	// at the element verbs or `edit`.
	jsonKind
)

type configKey struct {
	// Dotted path into the JSON document, verbatim field names.
	name string
	kind configKind
	enum []string
	// Effective value when the key is absent (nil = genuinely unset).
	// Doubles as the normalize-on-write target: setting a key to its
	// default deletes it instead, matching the app's omit-on-default
	// serialization.
	def  any
	desc string
	// The schema requires this key: set refuses empty values, unset
	// refuses entirely, and whole-document writes must include it.
	required bool
	// Folds the raw value before parsing (customWorktreePath's
	// home-expansion + absolute check).
	normalize func(raw string) (string, error)
	// For jsonKind keys: validates each array element on `write`, so a
	// drifted payload can't land a file the app's schema then rejects.
	elem func(value any) error
	// For jsonKind keys: the element-verb command (without the binary
	// name) that `set` points at instead. Empty falls back to "edit or
	// the app".
	hint string
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
	{name: "launchers", kind: jsonKind, def: []any{}, elem: validLauncherEntry,
		desc: "Global custom launchers (`config launcher`)",
		hint: "config launcher add/rm"},
	{name: "hiddenLaunchers", kind: jsonKind, def: []any{}, elem: validStringEntry,
		desc: "Hidden launcher ids (via edit or the app)"},
}

// Mirrors ShigomoriConfigSchema. defaultBranch is required there -- a
// document without it fails the app's schema read outright.
var projectConfigKeys = []configKey{
	{name: "defaultBranch", kind: stringKind, required: true,
		desc: "Branch new worktrees fork from (required)"},
	{name: "scripts.setup", kind: stringKind,
		desc: "Runs after creating a worktree"},
	{name: "scripts.teardown", kind: stringKind,
		desc: "Runs before removing a worktree"},
	{name: "worktreeLayout", kind: enumKind, enum: []string{"managed-root", "in-project", "custom"},
		def:  "managed-root",
		desc: "Where managed worktrees live"},
	{name: "customWorktreePath", kind: stringKind, normalize: normalizeAbsolutePath,
		desc: "Absolute base dir for the custom layout"},
	{name: "useWorktreeInclude", kind: boolKind, def: true,
		desc: "Honor the repo's .worktreeinclude file"},
	{name: "portBase", kind: intKind,
		desc: "port-pool base port"},
	{name: "lastMergeMethod", kind: enumKind, enum: []string{"merge", "squash", "rebase"},
		desc: "Preferred PR merge method"},
	{name: "carryOver", kind: jsonKind, def: []any{}, elem: validCarryOverEntry,
		desc: "Files carried into new worktrees (`carryover` verbs)",
		hint: "projects config carryover add/rm"},
	{name: "launchers", kind: jsonKind, def: []any{}, elem: validLauncherEntry,
		desc: "Per-project launchers (`launcher` verbs)",
		hint: "projects config launcher add/rm"},
}

func normalizeAbsolutePath(raw string) (string, error) {
	abs := expandHome(raw)
	if !filepath.IsAbs(abs) {
		return "", usageErrf("customWorktreePath must be an absolute path.")
	}
	return abs, nil
}

// Element validators for `write` payloads, mirroring the zod element
// schemas (LauncherCommandSchema, CarryOverEntrySchema).
func validLauncherEntry(value any) error {
	m, ok := value.(map[string]any)
	if !ok {
		return errf("entries must be objects")
	}
	for _, field := range []string{"id", "label", "command"} {
		if s, ok := m[field].(string); !ok || strings.TrimSpace(s) == "" {
			return errf("entries need a non-empty %s", field)
		}
	}
	return nil
}

func validStringEntry(value any) error {
	if _, ok := value.(string); !ok {
		return errf("entries must be strings")
	}
	return nil
}

func validCarryOverEntry(value any) error {
	m, ok := value.(map[string]any)
	if !ok {
		return errf("entries must be objects")
	}
	path, ok := m["path"].(string)
	if !ok || path == "" || !isSafeRelPath(path) {
		return errf("entries need a path inside the project root")
	}
	if mode, ok := m["mode"].(string); !ok || (mode != "copy" && mode != "symlink") {
		return errf("entries need mode copy or symlink")
	}
	return nil
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

// The string forms git accepts for boolean config, normalized to a
// JSON bool. Enums and ints are validated to the schema's constraints.
func parseConfigValue(key configKey, raw string) (any, error) {
	switch key.kind {
	case boolKind:
		switch strings.ToLower(raw) {
		case "true", "on", "yes", "1":
			return true, nil
		case "false", "off", "no", "0":
			return false, nil
		}
		return nil, usageErrf("%s is a boolean: use true or false.", key.name)
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
	case int:
		switch v := value.(type) {
		case int:
			return v == def
		case json.Number:
			n, err := v.Int64()
			return err == nil && n == int64(def)
		}
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
// byte-identical instead of round-tripping through float64. A JSON
// `null` (or any non-object) is an error -- callers that tolerate it
// map the error to an empty document themselves.
func decodeConfigDoc(raw []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, errf("not a JSON object")
	}
	return doc, nil
}

// Missing reads as empty so list/get work on a fresh root. A file
// that exists but can't be decoded is an error: printing defaults in
// place of settings the user actually wrote is how a corrupt file
// turns an explicit deleteBranchOnRemove opt-out back into "true
// (default)" with exit 0. Writes go through updateConfigDoc, which
// refuses malformed content instead of clobbering it.
func readConfigDoc(path string) (map[string]any, error) {
	doc := map[string]any{}
	_, err := readJSONDoc(path, func(raw []byte) error {
		decoded, err := decodeConfigDoc(raw)
		if err != nil {
			return err
		}
		doc = decoded
		return nil
	})
	if err != nil {
		return nil, err
	}
	return doc, nil
}

// Both list verbs (launchers, carry-over) read one array-valued key.
// Absent or wrong-shaped reads as empty, matching the writers'
// treatment of these keys as opaque raw entries.
func readConfigArray(path, key string) ([]any, error) {
	doc, err := readConfigDoc(path)
	if err != nil {
		return nil, err
	}
	entries, _ := doc[key].([]any)
	if entries == nil {
		entries = []any{}
	}
	return entries, nil
}

// Read-modify-write under the sibling .lock (withFileLock), so two CLI
// invocations can't clobber each other's fields. A no-op mutation
// skips the write entirely -- no watcher poke, no mtime churn.
func updateConfigDoc(path string, fn func(doc map[string]any) error) error {
	return withFileLock(path, func() error {
		doc := map[string]any{}
		raw, readErr := os.ReadFile(path)
		switch {
		case readErr == nil:
			var decodeErr error
			if doc, decodeErr = decodeConfigDoc(raw); decodeErr != nil {
				// A hand-edit gone wrong: merging into the {} fallback
				// would atomically discard every other setting. The app
				// errors on such files too, so make the user fix it first.
				return errf("%s is not valid JSON (%v). Fix it (e.g. via `%s config edit`) and retry.",
					path, decodeErr, binaryName)
			}
			noteNewerSchema(path, raw)
		case !errors.Is(readErr, os.ErrNotExist):
			// Same trap one step earlier: a permission or IO error is
			// not an absent file, and treating it as one would rewrite
			// the config with nothing but the field being set. Only a
			// file that isn't there yet starts from {}.
			return errf("Couldn't read %s: %v", path, readErr)
		}
		before, err := json.Marshal(doc)
		if err != nil {
			return err
		}
		if err := fn(doc); err != nil {
			return err
		}
		after, err := json.Marshal(doc)
		if err != nil {
			return err
		}
		if bytes.Equal(before, after) {
			return nil
		}
		// After the no-op check, so stamping the marker onto a file
		// that predates it can't turn a write nobody asked for into an
		// mtime bump the watcher reacts to.
		stampSchemaVersion(doc)
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

// Omit-when-empty, like the app's serialization of every config array.
func setConfigList(doc map[string]any, name string, entries []any) {
	if len(entries) == 0 {
		delete(doc, name)
	} else {
		doc[name] = entries
	}
}

// Like configDocGet, but a wrong-typed intermediate ({"scripts":
// "oops"}) is an error rather than "absent" -- the distinction
// validateConfigDoc needs to reject such documents.
func configDocLookup(doc map[string]any, name string) (any, bool, error) {
	var cur any = doc
	parts := strings.Split(name, ".")
	for i, part := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false, errf("%s must be an object.", strings.Join(parts[:i], "."))
		}
		if cur, ok = m[part]; !ok {
			return nil, false, nil
		}
	}
	return cur, true, nil
}

// Shape check for `write --data` payloads: required keys must be
// present, and every registry key that is present must carry its
// schema'd type (elements included), so engine drift fails loudly here
// instead of surfacing as a document zod later rejects wholesale.
// Unknown keys pass through untouched (forward compatibility).
func validateConfigDoc(keys []configKey, doc map[string]any) error {
	for _, key := range keys {
		value, present, err := configDocLookup(doc, key.name)
		if err != nil {
			return err
		}
		if !present {
			if key.required {
				return errf("%s is required.", key.name)
			}
			continue
		}
		switch key.kind {
		case boolKind:
			if _, ok := value.(bool); !ok {
				return errf("%s must be a boolean.", key.name)
			}
		case stringKind:
			s, ok := value.(string)
			if !ok {
				return errf("%s must be a string.", key.name)
			}
			if key.required && strings.TrimSpace(s) == "" {
				return errf("%s is required.", key.name)
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
			arr, ok := value.([]any)
			if !ok {
				return errf("%s must be an array.", key.name)
			}
			if key.elem != nil {
				for _, entry := range arr {
					if err := key.elem(entry); err != nil {
						return errf("%s: %v.", key.name, err)
					}
				}
			}
		}
	}
	return nil
}

// --- scopes ---

// Everything that differs between `sm config` and `sm projects
// config`: the document's location, its key registry, output
// decoration, and the write hooks. Every verb below is written once
// against this.
type configDocScope struct {
	path        string
	keys        []configKey
	usagePrefix string // "config" | "projects config"
	usageSuffix string // "" | " [-p <project>]"
	suffix      string // "" | " for <project>"
	project     string // rides along in --json documents when set
	// Runs inside the lock before each read-modify-write lands. An
	// error aborts the write (the project scope's defaultBranch
	// backfill, which refuses to produce a schema-invalid document).
	beforeWrite func(doc map[string]any) error
	// Runs after any successful update with the document that landed
	// (the project scope's in-project exclude side effect).
	afterWrite func(doc map[string]any)
}

func globalConfigScope() configDocScope {
	return configDocScope{
		path:        configJSONPath(),
		keys:        globalConfigKeys,
		usagePrefix: "config",
	}
}

func (s configDocScope) update(fn func(doc map[string]any) error) error {
	var final map[string]any
	err := updateConfigDoc(s.path, func(doc map[string]any) error {
		if err := fn(doc); err != nil {
			return err
		}
		if s.beforeWrite != nil {
			if err := s.beforeWrite(doc); err != nil {
				return err
			}
		}
		final = doc
		return nil
	})
	if err == nil && s.afterWrite != nil {
		s.afterWrite(final)
	}
	return err
}

func (s configDocScope) emitOK(fields map[string]any) {
	result := map[string]any{"ok": true}
	if s.project != "" {
		result["project"] = s.project
	}
	for k, v := range fields {
		result[k] = v
	}
	emit(result)
}

func (s configDocScope) usageErr(usage string) error {
	return usageErrf("Usage: %s %s %s%s", binaryName, s.usagePrefix, usage, s.usageSuffix)
}

func (s configDocScope) wantPositionals(positionals []string, n int, usage string) error {
	if len(positionals) != n {
		return s.usageErr(usage)
	}
	return nil
}

// --- the shared verbs ---

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

func runConfigList(scope configDocScope) (int, error) {
	doc, err := readConfigDoc(scope.path)
	if err != nil {
		return exitCodeOf(err), err
	}
	entries := configListEntries(scope.keys, doc)
	if jsonMode {
		scope.emitOK(map[string]any{"settings": entries})
		return 0, nil
	}
	rows := make([][]string, len(entries))
	for i, entry := range entries {
		cell := renderConfigValue(entry.Value)
		if !entry.Set {
			// The marker is text, not just dimming: meaning must survive
			// pipes and --json-less scripting.
			marker := "(default)"
			if scope.keys[i].def == nil {
				marker = "(unset)"
			}
			if cell == "" {
				cell = dimOut(marker)
			} else {
				cell += " " + dimOut(marker)
			}
		}
		rows[i] = []string{entry.Key, cell, dimOut(scope.keys[i].desc)}
	}
	out(renderTable([]string{"KEY", "VALUE", "DESCRIPTION"}, rows))
	return 0, nil
}

// get prints the effective value bare on stdout (nothing when the key
// is unset and has no default), so command substitution stays clean.
func runConfigGet(scope configDocScope, name string) (int, error) {
	key, err := lookupConfigKey(scope.keys, name)
	if err != nil {
		return exitCodeOf(err), err
	}
	doc, err := readConfigDoc(scope.path)
	if err != nil {
		return exitCodeOf(err), err
	}
	value, set := configDocGet(doc, key.name)
	if !set {
		value = key.def
	}
	if jsonMode {
		scope.emitOK(map[string]any{"key": key.name, "value": value, "set": set})
		return 0, nil
	}
	if value != nil {
		out(renderConfigValue(value))
	}
	return 0, nil
}

func runConfigSet(scope configDocScope, name, raw string) (int, error) {
	key, err := lookupConfigKey(scope.keys, name)
	if err != nil {
		return exitCodeOf(err), err
	}
	if key.kind == jsonKind {
		return 2, structuredKeyErr(key, scope.usagePrefix+" edit")
	}
	if key.required && strings.TrimSpace(raw) == "" {
		// An empty required value makes the whole document invalid to
		// the schema, which would silently drop every other configured
		// field on the next read. Refuse instead of "clear".
		return 2, usageErrf(
			"%s can't be empty: it's required, so set a value instead of clearing it.", key.name)
	}
	if key.kind == stringKind && raw == "" {
		// "" clears, matching the long-standing `--setup ''` behavior.
		return runConfigUnset(scope, name)
	}
	if key.normalize != nil {
		if raw, err = key.normalize(raw); err != nil {
			return exitCodeOf(err), err
		}
	}
	value, err := parseConfigValue(key, raw)
	if err != nil {
		return exitCodeOf(err), err
	}
	err = scope.update(func(doc map[string]any) error {
		if equalsConfigDefault(key, value) {
			configDocDelete(doc, key.name)
		} else {
			configDocSet(doc, key.name, value)
		}
		return nil
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		scope.emitOK(map[string]any{"key": key.name, "value": value})
	} else {
		out(greenOut("set " + key.name + " = " + renderConfigValue(value) + scope.suffix))
	}
	return 0, nil
}

func runConfigUnset(scope configDocScope, name string) (int, error) {
	key, err := lookupConfigKey(scope.keys, name)
	if err != nil {
		return exitCodeOf(err), err
	}
	if key.required {
		return 2, usageErrf(
			"%s can't be cleared: it's required, so set a different value instead.", key.name)
	}
	err = scope.update(func(doc map[string]any) error {
		configDocDelete(doc, key.name)
		return nil
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		scope.emitOK(map[string]any{"key": key.name})
	} else {
		suffix := ""
		if key.def != nil {
			suffix = " (default: " + renderConfigValue(key.def) + ")"
		}
		out(greenOut("unset " + key.name + suffix + scope.suffix))
	}
	return 0, nil
}

// The merge a whole-document `write` lands into what's on disk. The
// payload owns the scope's registry: a key it carries is written, a
// registry key it omits is deleted (that is how the app clears a
// setting back to its default, since it serializes defaults by
// omission). Everything else already in the file is kept, so a key
// only a newer version models survives an older build's save. The
// app's zod schemas strip what they don't model, so the payload can't
// be relied on to carry such a key back on its own.
// Objects merge field by field for the same reason, which keeps an
// unknown field sitting beside scripts.setup. Arrays and scalars
// replace wholesale: element-wise merging would resurrect entries the
// user just removed.
// Either way the registry lands exactly as the payload asks, whatever
// shape the file happens to hold, so a hand-edited `"scripts": "oops"`
// is repaired here rather than written back out for the app's schema
// to choke on.
func mergeConfigDoc(keys []configKey, doc, payload map[string]any) {
	for _, key := range keys {
		if _, ok := configDocGet(payload, key.name); !ok {
			configDocClear(doc, key.name)
		}
	}
	mergeJSONObjects(doc, payload)
}

// configDocDelete for the write path, where giving up is not an
// option. It walks away from a dotted key whose parent holds a
// non-object, which would leave a registry key the payload cleared
// sitting on disk in a document the app then refuses to read. Drop the
// wrong-shape parent whole instead: a scalar, an array or a null has
// no fields under it, so there is no unknown sibling to preserve, and
// the parent is the registry's own namespace rather than a key some
// newer version owns. A payload that carries the same parent puts its
// object back in the merge below.
func configDocClear(doc map[string]any, name string) {
	parts := strings.Split(name, ".")
	m := doc
	for i, part := range parts[:len(parts)-1] {
		child, present := m[part]
		if !present {
			return
		}
		parent, isObject := child.(map[string]any)
		if !isObject {
			configDocDelete(doc, strings.Join(parts[:i+1], "."))
			return
		}
		m = parent
	}
	configDocDelete(doc, name)
}

func mergeJSONObjects(doc, payload map[string]any) {
	for name, value := range payload {
		if child, ok := value.(map[string]any); ok {
			if existing, isObject := doc[name].(map[string]any); isObject {
				mergeJSONObjects(existing, child)
				continue
			}
		}
		doc[name] = value
	}
}

// Whole-document write for the plumbing `write --data` verb. The
// payload was already zod-parsed app-side. validateConfigDoc re-checks
// the shape (including required keys) so engine drift fails loudly,
// then mergeConfigDoc folds it into what is on disk under the lock.
// Routing through scope.update rather than a raw locked write is also
// what keeps the schemaVersion stamp and the no-op check on this path,
// so a payload that changes nothing still writes nothing.
func runConfigWrite(scope configDocScope, data string) (int, error) {
	if data == "" {
		return 2, usageErrf("write requires --data '<json>'.")
	}
	payload, err := decodeConfigDoc([]byte(data))
	if err != nil {
		return 2, usageErrf("--data must be a JSON object: %v", err)
	}
	if err := validateConfigDoc(scope.keys, payload); err != nil {
		return 1, err
	}
	err = scope.update(func(doc map[string]any) error {
		mergeConfigDoc(scope.keys, doc, payload)
		return nil
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	emit(map[string]any{"ok": true})
	return 0, nil
}

// The verbs both dispatchers share. handled=false means the verb
// belongs to the caller (bare/edit/carryover/unknown).
func runSharedConfigVerb(scope configDocScope, parsed parsedArgs) (bool, int, error) {
	code, err := 0, error(nil)
	switch parsed.positionals[0] {
	case "list":
		code, err = runConfigList(scope)
	case "get":
		if err = scope.wantPositionals(parsed.positionals, 2, "get <key>"); err == nil {
			code, err = runConfigGet(scope, parsed.positionals[1])
		} else {
			code = 2
		}
	case "set":
		if err = scope.wantPositionals(parsed.positionals, 3, "set <key> <value>"); err == nil {
			code, err = runConfigSet(scope, parsed.positionals[1], parsed.positionals[2])
		} else {
			code = 2
		}
	case "unset":
		if err = scope.wantPositionals(parsed.positionals, 2, "unset <key>"); err == nil {
			code, err = runConfigUnset(scope, parsed.positionals[1])
		} else {
			code = 2
		}
	case "launcher", "launchers":
		code, err = runLauncherVerb(scope, parsed.positionals[1:])
	case "write":
		code, err = runConfigWrite(scope, parsed.strings["data"])
	default:
		return false, 0, nil
	}
	return true, code, err
}

// The refusal for `set` on a structured key, pointing at the element
// verbs where they exist.
func structuredKeyErr(key configKey, editCmd string) error {
	hint := "`" + binaryName + " " + editCmd + "` or the app"
	if key.hint != "" {
		hint = "`" + binaryName + " " + key.hint + "`"
	}
	return usageErrf("%s is structured: use %s.", key.name, hint)
}

// --- sm config (global) ---

func cmdConfigGlobal(_ cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"data": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if len(parsed.positionals) == 0 {
		out(namespaceHelp("config"))
		return 0, nil
	}
	scope := globalConfigScope()
	if handled, code, err := runSharedConfigVerb(scope, parsed); handled {
		return code, err
	}
	switch sub := parsed.positionals[0]; sub {
	case "edit":
		return openConfigFileInEditor(scope.path)
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s config <list|get|set|unset|edit|launcher> [args]",
			sub, binaryName)
	}
}

// --- structured lists: element verbs (launcher here, carry-over in
// cmd_project.go) ---

// sm [projects] config launcher [add <label> <command> | rm <ref>] --
// element verbs over the launchers array. Ids are minted like the
// app's (a lowercase uuid, shown in the launcher row as
// custom:<id>). rm takes the id or an unambiguous label. Entries are
// kept as raw maps so fields this CLI doesn't model survive.
func runLauncherVerb(scope configDocScope, rest []string) (int, error) {
	verb := "list"
	if len(rest) > 0 {
		verb = rest[0]
	}
	switch verb {
	case "list":
		launchers, err := readConfigArray(scope.path, "launchers")
		if err != nil {
			return exitCodeOf(err), err
		}
		if jsonMode {
			scope.emitOK(map[string]any{"launchers": launchers})
			return 0, nil
		}
		if len(launchers) == 0 {
			note("No custom launchers configured.")
			return 0, nil
		}
		var rows [][]string
		for _, entry := range launchers {
			m, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			label, _ := m["label"].(string)
			command, _ := m["command"].(string)
			id, _ := m["id"].(string)
			rows = append(rows, []string{label, command, dimOut(id)})
		}
		out(renderTable([]string{"LABEL", "COMMAND", "ID"}, rows))
		return 0, nil
	case "add":
		if len(rest) != 3 {
			return 2, scope.usageErr("launcher add <label> <command>")
		}
		label, command := rest[1], rest[2]
		// The schema requires both non-empty (LauncherCommandSchema);
		// the app additionally drops half-filled rows on save.
		if strings.TrimSpace(label) == "" || strings.TrimSpace(command) == "" {
			return 2, usageErrf("Label and command can't be empty.")
		}
		launcher := map[string]any{"id": newRunID(), "label": label, "command": command}
		err := scope.update(func(doc map[string]any) error {
			launchers, _ := doc["launchers"].([]any)
			doc["launchers"] = append(launchers, launcher)
			return nil
		})
		if err != nil {
			return exitCodeOf(err), err
		}
		if jsonMode {
			scope.emitOK(map[string]any{"launcher": launcher})
		} else {
			out(greenOut("added launcher " + label + scope.suffix))
		}
		return 0, nil
	case "rm", "remove":
		if len(rest) != 2 {
			return 2, scope.usageErr("launcher rm <label-or-id>")
		}
		ref := rest[1]
		var removed map[string]any
		err := scope.update(func(doc map[string]any) error {
			launchers, _ := doc["launchers"].([]any)
			// Exact id match wins. Otherwise the label must identify a
			// single entry (labels aren't unique, ids are). Removal is
			// by index so an id-less entry (hand-edited file) can't
			// drag its id-less siblings along.
			matches := launcherMatches(launchers, ref)
			switch len(matches) {
			case 0:
				return errf("No launcher matches %q.%s", ref, scope.suffix)
			case 1:
				// Deliberate index removal below.
			default:
				refs := make([]string, len(matches))
				for i, idx := range matches {
					if id, _ := launchers[idx].(map[string]any)["id"].(string); id != "" {
						refs[i] = id
					} else {
						refs[i] = "(no id, use `edit`)"
					}
				}
				return errf("%d launchers are labeled %q. Remove by id: %s.",
					len(matches), ref, strings.Join(refs, ", "))
			}
			idx := matches[0]
			removed = launchers[idx].(map[string]any)
			setConfigList(doc, "launchers", append(append([]any{}, launchers[:idx]...), launchers[idx+1:]...))
			return nil
		})
		if err != nil {
			return exitCodeOf(err), err
		}
		label, _ := removed["label"].(string)
		if jsonMode {
			scope.emitOK(map[string]any{"removed": removed})
		} else {
			out(greenOut("removed launcher " + label + scope.suffix))
		}
		return 0, nil
	default:
		return 2, scope.usageErr("launcher [add <label> <command> | rm <label-or-id>]")
	}
}

// Indices of the entries matching a launcher reference. Matching
// follows cmd_open's matchLauncher: ids and labels case-insensitively,
// plus the row-entry spelling custom:<id>. An id match is unique by
// construction and returns alone.
func launcherMatches(launchers []any, ref string) []int {
	var byLabel []int
	for i, entry := range launchers {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := m["id"].(string); id != "" &&
			(strings.EqualFold(id, ref) || strings.EqualFold("custom:"+id, ref)) {
			return []int{i}
		}
		if label, _ := m["label"].(string); strings.EqualFold(label, ref) {
			byLabel = append(byLabel, i)
		}
	}
	return byLabel
}

// Opens a config file in $VISUAL/$EDITOR in an interactive terminal,
// the OS opener otherwise. --json (and editor-less non-darwin) just
// reports the path. Seeds an empty document so a save round-trips.
func openConfigFileInEditor(path string) (int, error) {
	if _, err := os.Stat(path); err != nil {
		seeded := map[string]any{}
		stampSchemaVersion(seeded)
		if writeErr := atomicWriteJSON(path, seeded); writeErr != nil {
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
		// The editor bypasses updateConfigDoc's refusal of malformed
		// content, so a stray trailing comma would otherwise surface
		// only on some later command. Say it now, while the mistake is
		// one keystroke old.
		if raw, err := os.ReadFile(path); err == nil {
			if _, decodeErr := decodeConfigDoc(raw); decodeErr != nil {
				noteFileTrouble(path,
					"Commands that read it will refuse until it parses.",
					errf("%s is not valid JSON after the edit (%v)", path, decodeErr))
			}
		}
		return 0, nil
	}
	if err := exec.Command("open", path).Run(); err != nil {
		return 1, errf("Couldn't open %s: %v", path, err)
	}
	out("opened " + path)
	return 0, nil
}
