package main

// sm agents install / uninstall / status: the hook entries that run
// `sm agents event` in each harness's own hooks file. Edits leave
// everything else in the file as it was (key order included), and an
// entry is recognizably ours by its command: this binary's name
// running `agents event --harness <id>`, so a dev build (smd) and the
// installed sm keep their own entries side by side.
//
// Codex runs a hook only once the user has trusted it (its /hooks
// review), keyed by a hash of the entry, so status reports that too.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// One hook entry: the event, an optional matcher, and whether it runs
// in the background. PostToolUse fires on every tool, so it never
// holds the agent up.
type hookSpec struct {
	event   string
	matcher string
	async   bool
}

type hookInstall struct {
	// The harness's config dir. It existing is what "detected" means.
	dir  func() string
	file string
	// Whether the harness wants each hook trusted first (Codex).
	trust bool
	// Whether the file holds nothing but hooks, so one left empty goes.
	ownsFile bool
	hooks    []hookSpec
}

// Every hook gets this many seconds. Codex caps SessionEnd and
// Interrupt at 3, and the event itself takes milliseconds.
const hookTimeout = 3

var harnesses = []harness{
	{id: "claude", label: "Claude Code", sessionEnv: "CLAUDE_CODE_SESSION_ID", install: hookInstall{
		dir:  func() string { return homeOr("CLAUDE_CONFIG_DIR", ".claude") },
		file: "settings.json",
		hooks: []hookSpec{
			{event: "UserPromptSubmit"},
			{event: "PermissionRequest"},
			{event: "PostToolUse", async: true},
			{event: "Notification", matcher: "idle_prompt"},
			{event: "Stop"},
			{event: "StopFailure"},
			{event: "SessionEnd"},
		},
	}},
	{id: "codex", label: "Codex", sessionEnv: "CODEX_THREAD_ID", install: hookInstall{
		dir:      func() string { return homeOr("CODEX_HOME", ".codex") },
		file:     "hooks.json",
		trust:    true,
		ownsFile: true,
		hooks: []hookSpec{
			{event: "UserPromptSubmit"},
			{event: "PermissionRequest"},
			{event: "PostToolUse", async: true},
			{event: "Stop"},
			{event: "Interrupt"},
			{event: "SessionEnd"},
		},
	}},
}

func homeOr(env, dir string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, dir)
}

func (h harness) hooksPath() string { return filepath.Join(h.install.dir(), h.install.file) }

func (h harness) detected() bool {
	info, err := os.Stat(h.install.dir())
	return err == nil && info.IsDir()
}

// This binary as the hooks should run it: its real path, so the app
// (which runs the bundled binary) and a terminal (through the linked
// command) write the same entry and agree on whether it is current.
// Absolute, since a GUI-launched harness may not have the user's PATH.
var hookBinary = func() string {
	exe, _ := os.Executable()
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		return real
	}
	return exe
}

func (h harness) hookCommand() string {
	return shellQuote(hookBinary()) + " agents event --harness " + h.id
}

// Whether a hook command is one of ours for this harness, whatever
// path it names the binary by.
func (h harness) isOurCommand(command string) bool {
	bin, rest := command, ""
	if strings.HasPrefix(command, "'") {
		if end := strings.Index(command[1:], "'"); end >= 0 {
			bin, rest = command[1:end+1], command[end+2:]
		}
	} else if i := strings.IndexByte(command, ' '); i >= 0 {
		bin, rest = command[:i], command[i:]
	}
	return filepath.Base(bin) == binaryName && strings.TrimSpace(rest) == "agents event --harness "+h.id
}

// --- JSON objects that keep their key order ---

type jsonObject struct {
	keys []string
	vals map[string]json.RawMessage
}

func parseJSONObject(raw []byte) (*jsonObject, error) {
	o := &jsonObject{vals: map[string]json.RawMessage{}}
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("not a JSON object")
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		o.set(tok.(string), v)
	}
	return o, nil
}

func (o *jsonObject) set(key string, v json.RawMessage) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

func (o *jsonObject) del(key string) {
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *jsonObject) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		key, _ := json.Marshal(k)
		b.Write(key)
		b.WriteByte(':')
		b.Write(o.vals[k])
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func mustRaw(v any) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSpace(b.Bytes())
}

// --- the hooks file ---

// A hooks file: its top-level object, and its "hooks" object's groups
// per event, in order.
type hooksDoc struct {
	path  string
	top   *jsonObject
	hooks *jsonObject
}

type hookGroup struct {
	Matcher string           `json:"matcher,omitempty"`
	Hooks   []map[string]any `json:"hooks"`
}

func readHooksDoc(path string) (*hooksDoc, error) {
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	top, err := parseJSONObject(raw)
	if err != nil {
		return nil, errf("%s isn't a JSON object (%v). Fix it, then retry.", path, err)
	}
	hooks, err := parseJSONObject(top.vals["hooks"])
	if err != nil {
		return nil, errf("%s holds a malformed \"hooks\" value (%v). Fix it, then retry.", path, err)
	}
	// Each event holds a list of groups. Anything else would be lost
	// when an install rewrites the event.
	for _, event := range hooks.keys {
		var groups []json.RawMessage
		if err := json.Unmarshal(hooks.vals[event], &groups); err != nil {
			return nil, errf("%s holds a malformed %q hook list (%v). Fix it, then retry.", path, event, err)
		}
	}
	return &hooksDoc{path: path, top: top, hooks: hooks}, nil
}

func (d *hooksDoc) groups(event string) []json.RawMessage {
	var groups []json.RawMessage
	_ = json.Unmarshal(d.hooks.vals[event], &groups)
	return groups
}

// Drops every handler of ours, then any group and event left empty.
func (d *hooksDoc) removeOurs(h harness) {
	for _, event := range append([]string{}, d.hooks.keys...) {
		var kept []json.RawMessage
		changed := false
		for _, raw := range d.groups(event) {
			group, err := parseJSONObject(raw)
			var handlers []json.RawMessage
			if err != nil || json.Unmarshal(group.vals["hooks"], &handlers) != nil {
				kept = append(kept, raw)
				continue
			}
			var keptHandlers []json.RawMessage
			for _, handler := range handlers {
				var fields struct{ Command string }
				if json.Unmarshal(handler, &fields) == nil && h.isOurCommand(fields.Command) {
					changed = true
					continue
				}
				keptHandlers = append(keptHandlers, handler)
			}
			if len(keptHandlers) == len(handlers) {
				kept = append(kept, raw)
			} else if len(keptHandlers) > 0 {
				group.set("hooks", mustRaw(keptHandlers))
				kept = append(kept, mustRaw(group))
			}
		}
		switch {
		case !changed:
		case len(kept) == 0:
			d.hooks.del(event)
		default:
			d.hooks.set(event, mustRaw(kept))
		}
	}
}

// The one hook entry a spec installs.
func hookHandler(spec hookSpec, command string) map[string]any {
	handler := map[string]any{"type": "command", "command": command, "timeout": hookTimeout}
	if spec.async {
		handler["async"] = true
	}
	return handler
}

func (h harness) handler(spec hookSpec) map[string]any {
	return hookHandler(spec, h.hookCommand())
}

func (d *hooksDoc) addOurs(h harness) {
	for _, spec := range h.install.hooks {
		group := hookGroup{Matcher: spec.matcher, Hooks: []map[string]any{h.handler(spec)}}
		d.hooks.set(spec.event, mustRaw(append(d.groups(spec.event), mustRaw(group))))
	}
}

func (d *hooksDoc) write(removeIfEmpty bool) error {
	if len(d.hooks.keys) == 0 {
		d.top.del("hooks")
	} else {
		d.top.set("hooks", mustRaw(d.hooks))
	}
	// A symlinked file is someone's dotfile: it stays, emptied.
	info, err := os.Lstat(d.path)
	symlink := err == nil && info.Mode()&os.ModeSymlink != 0
	if removeIfEmpty && len(d.top.keys) == 0 && !symlink {
		if err := os.Remove(d.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	var compact, out bytes.Buffer
	if err := json.Compact(&compact, mustRaw(d.top)); err != nil {
		return err
	}
	if err := json.Indent(&out, compact.Bytes(), "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	// Through a symlink (a dotfiles repo's) to the file itself, so the
	// rename replaces the file and the link stays.
	path := d.path
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	return writeHookFile(path, out.String(), rcFileMode(path))
}

// Where each of our entries sits: [event] -> group index, for the ones
// that match the spec exactly, plus how many of ours there are at all.
func (d *hooksDoc) ourEntries(h harness) (exact map[string]int, total int) {
	exact = map[string]int{}
	want := map[string]hookSpec{}
	for _, spec := range h.install.hooks {
		want[spec.event] = spec
	}
	for _, event := range d.hooks.keys {
		for gi, raw := range d.groups(event) {
			var group hookGroup
			if json.Unmarshal(raw, &group) != nil {
				continue
			}
			for _, handler := range group.Hooks {
				command, _ := handler["command"].(string)
				if !h.isOurCommand(command) {
					continue
				}
				total++
				spec, wanted := want[event]
				if !wanted || len(group.Hooks) != 1 || group.Matcher != spec.matcher {
					continue
				}
				if string(mustRaw(handler)) == string(mustRaw(h.handler(spec))) {
					exact[event] = gi
				}
			}
		}
	}
	return exact, total
}

// --- Codex hook trust ---

// Codex's trust hash for one hook (codex-rs hooks discovery, hook_hash
// over config fingerprint's version_for_toml): sha256 of the
// normalized entry as compact JSON with sorted keys. The normalized
// handler always carries its timeout and async, and drops unset
// optionals.
func codexHookHash(spec hookSpec, command string) string {
	handler := hookHandler(spec, command)
	handler["async"] = spec.async
	identity := map[string]any{"event_name": snakeCase(spec.event), "hooks": []any{handler}}
	if spec.matcher != "" {
		identity["matcher"] = spec.matcher
	}
	sum := sha256.Sum256(mustRaw(identity))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func snakeCase(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('_')
			}
			r += 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}

var tomlTableRe = regexp.MustCompile(`^\s*\[\s*hooks\.state\."((?:[^"\\]|\\.)*)"\s*\]\s*$`)
var tomlTrustedRe = regexp.MustCompile(`^\s*trusted_hash\s*=\s*"([^"]*)"`)

// The trusted hashes in Codex's config.toml, by hook key
// ("<hooks file>:<event>:<group>:<handler>"). Only the table form Codex
// writes is read.
func codexTrustedHashes(dir string) map[string]string {
	raw, _ := os.ReadFile(filepath.Join(dir, "config.toml"))
	hashes := map[string]string{}
	table := ""
	for _, line := range strings.Split(string(raw), "\n") {
		if m := tomlTableRe.FindStringSubmatch(line); m != nil {
			table = strings.ReplaceAll(m[1], `\\`, `\`)
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			table = ""
			continue
		}
		if m := tomlTrustedRe.FindStringSubmatch(line); m != nil && table != "" {
			hashes[table] = m[1]
		}
	}
	return hashes
}

// --- the commands ---

type harnessStatus struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Detected bool   `json:"detected"`
	Path     string `json:"path"`
	// installed, outdated (ours, but not what this build would write:
	// install again) or missing.
	Hooks string `json:"hooks"`
	// For a harness that trusts hooks one by one, once installed:
	// whether it trusts every one of ours.
	Trusted *bool `json:"trusted,omitempty"`
}

func (h harness) status() harnessStatus {
	st := harnessStatus{ID: h.id, Label: h.label, Detected: h.detected(), Path: h.hooksPath(), Hooks: "missing"}
	doc, err := readHooksDoc(st.Path)
	if err != nil {
		return st
	}
	exact, total := doc.ourEntries(h)
	switch {
	case total == 0:
		return st
	case total != len(h.install.hooks) || len(exact) != len(h.install.hooks):
		st.Hooks = "outdated"
		return st
	}
	st.Hooks = "installed"
	if h.install.trust {
		hashes := codexTrustedHashes(h.install.dir())
		// Codex keys by the resolved path.
		keyPath, err := filepath.EvalSymlinks(st.Path)
		if err != nil {
			keyPath = st.Path
		}
		trusted := true
		for _, spec := range h.install.hooks {
			key := keyPath + ":" + snakeCase(spec.event) + ":" + strconv.Itoa(exact[spec.event]) + ":0"
			if hashes[key] != codexHookHash(spec, h.hookCommand()) {
				trusted = false
			}
		}
		st.Trusted = &trusted
	}
	return st
}

// The harnesses a command names, or every detected one.
func harnessArgs(ids []string) ([]harness, error) {
	if len(ids) == 0 {
		var found []harness
		for _, h := range harnesses {
			if h.detected() {
				found = append(found, h)
			}
		}
		return found, nil
	}
	var picked []harness
	for _, id := range ids {
		h := lookupHarness(id)
		if h == nil {
			return nil, usageErrf("Unknown harness %q. Known: %s.", id,
				joinMapped(harnesses, func(h harness) string { return h.id }))
		}
		picked = append(picked, *h)
	}
	return picked, nil
}

func cmdAgentsInstall(args []string, install bool) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{})
	if err != nil {
		return exitCodeOf(err), err
	}
	picked, err := harnessArgs(parsed.positionals)
	if err != nil {
		return exitCodeOf(err), err
	}
	for _, h := range picked {
		if install && !h.detected() {
			return 1, errf("%s isn't set up here (no %s)", h.label, h.install.dir())
		}
		doc, err := readHooksDoc(h.hooksPath())
		if err != nil {
			return 1, err
		}
		doc.removeOurs(h)
		if install {
			doc.addOurs(h)
		}
		if err := doc.write(!install && h.install.ownsFile); err != nil {
			return 1, err
		}
		if !jsonMode {
			st := h.status()
			verb := "installed"
			if !install {
				verb = "uninstalled"
			}
			line := greenOut(verb+" the "+h.label+" hooks") + dimOut(" ("+st.Path+")")
			if st.Trusted != nil && !*st.Trusted {
				line += "\n  " + yellowOut("Codex runs them once trusted: review them with /hooks in Codex.")
			}
			out(line)
		}
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "harnesses": harnessStatuses()})
	} else if len(picked) == 0 {
		note("No supported harness found (" + joinMapped(harnesses, func(h harness) string { return h.label }) + ").")
	}
	return 0, nil
}

// Every harness's status, the --json answer of status, install and
// uninstall alike.
func harnessStatuses() []harnessStatus {
	statuses := make([]harnessStatus, len(harnesses))
	for i, h := range harnesses {
		statuses[i] = h.status()
	}
	return statuses
}

func cmdAgentsStatus(args []string) (int, error) {
	if _, err := parseCmdArgs(args, argSpec{}); err != nil {
		return exitCodeOf(err), err
	}
	statuses := harnessStatuses()
	if jsonMode {
		emit(map[string]any{"ok": true, "harnesses": statuses})
		return 0, nil
	}
	var rows [][]string
	for _, st := range statuses {
		state := st.Hooks
		switch {
		case !st.Detected:
			state = "not found"
		case st.Trusted != nil && !*st.Trusted:
			state += ", untrusted (/hooks in Codex)"
		}
		rows = append(rows, []string{st.Label, state, dimOut(st.Path)})
	}
	for _, line := range alignRows(rows) {
		out(line)
	}
	return 0, nil
}
