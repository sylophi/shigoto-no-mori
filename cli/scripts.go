package main

// Lifecycle script execution (setup / teardown / port-pool), ported
// from host/lib/scripts/. The CLI runs scripts in the foreground and
// shares the terminal's process group, so Ctrl-C reaches the whole
// tree naturally -- none of the app's background kill machinery is
// needed. Env, shell selection, and event shapes match the app so
// scripts and --json consumers see identical behavior.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// scriptSlot mirrors the ScriptEventSchema slot union.
type scriptSlot struct {
	Kind  string `json:"kind"`            // "setup" | "teardown" | "portPool"
	Phase string `json:"phase,omitempty"` // "provision" | "release" for portPool
}

func (s scriptSlot) label() string {
	if s.Kind == "portPool" {
		return "port-pool " + s.Phase
	}
	return s.Kind
}

type scriptEnvInputs struct {
	scriptName    string
	worktree      worktreeIdentity
	proj          project
	projectBranch string
	defaultBranch string
}

// Login shell (no -i), same selection as scripts/process.ts.
// The app also consults the passwd entry for GUI launches with an
// empty $SHELL; a CLI always runs from a terminal, where $SHELL is
// set, so /bin/sh is a sufficient fallback.
func resolveShell() (string, []string) {
	if fromEnv := os.Getenv("SHELL"); fromEnv != "" {
		return fromEnv, []string{"-l", "-c"}
	}
	return "/bin/sh", []string{"-c"}
}

// The SHIGOMORI_* contract vars (shared/scriptEnv.ts) on top of the
// ambient env. Base is envWithoutCdFile: a script that shells out to
// `sm cd` must not be able to retarget the outer wrapper's directive
// file. Stale SHIGOMORI_* values are dropped first so a script that
// itself invokes sm (or the app delegating a run through the CLI)
// can't leak a parent run's identity into this one. SHIGOMORI_ROOT
// isn't part of the contract and passes through untouched: when a
// caller has sandboxed the root, the sandbox should cover the whole
// tree. Nothing on either side adds one -- see initShigomoriRoot
// (host/lib/util/paths.ts) for why injecting it is the bug.
func scriptEnv(in scriptEnvInputs) []string {
	contract := map[string]string{
		"SHIGOMORI_SCRIPT_NAME":     in.scriptName,
		"SHIGOMORI_WORKTREE_PATH":   in.worktree.Path,
		"SHIGOMORI_WORKTREE_NAME":   in.worktree.Name,
		"SHIGOMORI_WORKTREE_BRANCH": in.worktree.Branch,
		"SHIGOMORI_WORKTREE_ID":     in.worktree.ID,
		"SHIGOMORI_PROJECT_PATH":    in.proj.Path,
		"SHIGOMORI_PROJECT_NAME":    in.proj.Name,
		"SHIGOMORI_PROJECT_BRANCH":  in.projectBranch,
		"SHIGOMORI_DEFAULT_BRANCH":  in.defaultBranch,
	}
	var env []string
	for _, kv := range envWithoutCdFile() {
		name, _, _ := strings.Cut(kv, "=")
		if _, stale := contract[name]; !stale {
			env = append(env, kv)
		}
	}
	// Sorted so a run's environment is reproducible, which the NDJSON
	// event stream and any diffing of it rely on.
	for _, name := range slices.Sorted(maps.Keys(contract)) {
		env = append(env, name+"="+contract[name])
	}
	return env
}

func newRunID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	hexs := hex.EncodeToString(b)
	return hexs[0:8] + "-" + hexs[8:12] + "-" + hexs[12:16] + "-" + hexs[16:20] + "-" + hexs[20:32]
}

// runLifecycleScript executes one script to completion, streaming
// output (stderr passthrough in human mode, NDJSON script events in
// --json). Returns the exit code (-1 means it never ran or died to a
// signal, the TS side's `null`) and the run's id, which cleanup-error
// reports reference so consumers can correlate the failing output.
func runLifecycleScript(command string, in scriptEnvInputs, slot scriptSlot) (int, string) {
	runID := newRunID()
	emitScriptEvent(map[string]any{
		"event": "script", "runId": runID, "kind": "started",
		"projectId": in.proj.ID, "worktreeId": in.worktree.ID, "slot": slot,
	}, slotMarker(slot)+" running")

	shell, shellArgs := resolveShell()
	cmd := exec.Command(shell, append(shellArgs, command)...)
	cmd.Dir = in.worktree.Path
	// The terminal-faking trio on top of the contract env: lifecycle
	// output is piped (through the CLI or the app's console), so tools
	// need convincing to emit ANSI. `sm run` deliberately skips these --
	// its script inherits the real terminal.
	cmd.Env = append(scriptEnv(in),
		"FORCE_COLOR=1",
		"TERM=xterm-256color",
		"COLUMNS=120",
	)

	// Merge stdout+stderr into one ordered stream like the app does.
	pipeR, pipeW := io.Pipe()
	cmd.Stdout = pipeW
	cmd.Stderr = pipeW

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 8192)
		for {
			n, err := pipeR.Read(buf)
			if n > 0 {
				chunk := string(buf[:n])
				if jsonMode {
					emit(map[string]any{
						"event": "script", "runId": runID, "kind": "data", "data": chunk,
					})
				} else {
					os.Stderr.WriteString(chunk)
				}
			}
			if err != nil {
				return
			}
		}
	}()

	code := 0
	if err := cmd.Start(); err != nil {
		pipeW.Close()
		wg.Wait()
		emitScriptEvent(map[string]any{
			"event": "script", "runId": runID, "kind": "error", "data": err.Error(),
		}, slotMarker(slot)+" "+err.Error())
		emitExit(runID, slot, -1)
		return -1, runID
	}
	err := cmd.Wait()
	pipeW.Close()
	wg.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode() // -1 when signaled, matching TS null
		} else {
			code = -1
		}
	}
	emitExit(runID, slot, code)
	return code, runID
}

func emitScriptEvent(event map[string]any, humanLine string) {
	if jsonMode {
		emit(event)
	} else {
		note(humanLine)
	}
}

// Dim the [label] marker so streamed script output stands out from the
// CLI's own framing lines.
func slotMarker(slot scriptSlot) string {
	return dimErr("[" + slot.label() + "]")
}

func emitExit(runID string, slot scriptSlot, code int) {
	if jsonMode {
		var codeField any
		if code >= 0 {
			codeField = code
		} // else null, like the app's signal/spawn-failure exits
		emit(map[string]any{"event": "script", "runId": runID, "kind": "exit", "code": codeField})
		return
	}
	switch {
	case code == 0:
		note(slotMarker(slot) + " done")
	case code < 0:
		note(slotMarker(slot) + " failed to run")
	default:
		note(slotMarker(slot) + " exited with code " + strconv.Itoa(code))
	}
}

// --- port-pool integration (host/lib/portPool.ts + command.ts) ---

func portPoolInstalled() bool {
	_, err := exec.LookPath("port-pool")
	return err == nil
}

// port-pool.config.json: which port names the project allocates, and
// the env files (var name -> template) port-pool writes them into.
// schemaVersion's presence is what marks the file as a real port-pool
// config rather than something else parked at that path.
type portPoolConfig struct {
	SchemaVersion json.RawMessage              `json:"schemaVersion"`
	PortNames     []string                     `json:"portNames"`
	EnvFiles      map[string]map[string]string `json:"envFiles"`
}

func (c portPoolConfig) configured() bool { return len(c.SchemaVersion) > 0 }

// One read of the file, so a caller that wants both the declared ports
// and "is this worktree configured at all" doesn't parse it twice.
func readPortPoolConfig(dir string) portPoolConfig {
	raw, err := os.ReadFile(filepath.Join(dir, "port-pool.config.json"))
	if err != nil {
		return portPoolConfig{}
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil {
		return portPoolConfig{}
	}
	// Key by key, tolerantly: "is this worktree configured" is the
	// question provision and release both hinge on, and a portNames or
	// envFiles shape this build doesn't model must not turn it into a
	// no -- release would then skip and leak the worktree's ports.
	config := portPoolConfig{SchemaVersion: keys["schemaVersion"]}
	_ = json.Unmarshal(keys["portNames"], &config.PortNames)
	_ = json.Unmarshal(keys["envFiles"], &config.EnvFiles)
	return config
}

func portPoolConfigured(dir string) bool {
	return readPortPoolConfig(dir).configured()
}

// The global toggle on its own, for the callers that ask about it
// without a worktree in hand.
func portPoolEnabled(global globalConfig) bool {
	return global.PortPool != nil && *global.PortPool
}

// The whole "does port-pool run here" rule, in one place: provision and
// release must agree or a worktree keeps a port it never gives back.
// Externals are excluded because no provision ever ran.
func portPoolActiveFor(global globalConfig, id worktreeIdentity) bool {
	if id.IsExternal || !portPoolEnabled(global) {
		return false
	}
	return portPoolInstalled() && portPoolConfigured(id.Path)
}

// --- provisioned ports (the reverse lookup) ---

type portInfo struct {
	Name string `json:"name"`
	Port int    `json:"port"`
	File string `json:"file"`
	Key  string `json:"key"`
}

// KEY=VALUE lines from a dotenv file: comments, blanks, `export `
// prefixes, and surrounding quotes off. Deliberately not a full dotenv
// parser -- these files are machine-written by port-pool.
func parseEnvAssignments(content string) map[string]string {
	env := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		trimmed = strings.TrimPrefix(trimmed, "export ")
		key, value, found := strings.Cut(trimmed, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		env[strings.TrimSpace(key)] = value
	}
	return env
}

// The value each declared port name currently holds, read back out of
// the env files rather than out of port-pool's own state -- the files
// are the contract both sides already agree on. Only whole-value
// templates ("${renderer}") can be reversed; a name embedded in a
// larger string (a URL, say) goes unreported instead of guessed at.
// First file that carries a name wins, so a name duplicated across env
// files is reported once.
func matchPorts(config portPoolConfig, files map[string]string) []portInfo {
	byTemplate := map[string]string{}
	for _, name := range config.PortNames {
		byTemplate["${"+name+"}"] = name
	}
	ports := []portInfo{}
	seen := map[string]bool{}
	for _, file := range slices.Sorted(maps.Keys(config.EnvFiles)) {
		content, ok := files[file]
		if !ok {
			continue
		}
		env := parseEnvAssignments(content)
		for _, key := range slices.Sorted(maps.Keys(config.EnvFiles[file])) {
			name, isPort := byTemplate[config.EnvFiles[file][key]]
			if !isPort || seen[name] {
				continue
			}
			port, err := strconv.Atoi(env[key])
			if err != nil || port <= 0 {
				continue
			}
			seen[name] = true
			ports = append(ports, portInfo{Name: name, Port: port, File: file, Key: key})
		}
	}
	return ports
}

func provisionedPorts(worktreePath string, config portPoolConfig) []portInfo {
	files := map[string]string{}
	for name := range config.EnvFiles {
		if content, err := os.ReadFile(filepath.Join(worktreePath, name)); err == nil {
			files[name] = string(content)
		}
	}
	return matchPorts(config, files)
}

// Same rule against the tolerant read of the global config, for the
// paths that only want to know whether anything will run.
func willRunPortPool(id worktreeIdentity) bool {
	return portPoolActiveFor(readGlobalConfigHints(), id)
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func portPoolCommand(phase, worktreePath string) string {
	return "port-pool " + phase + " " + shellQuote(worktreePath)
}
