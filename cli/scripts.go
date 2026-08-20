package main

// Lifecycle script execution (setup / teardown / port-pool), ported
// from main/lib/scripts/. The CLI runs scripts in the foreground and
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
// (main/lib/util/paths.ts) for why injecting it is the bug.
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

// --- port-pool integration (main/lib/portPool.ts + command.ts) ---

func portPoolInstalled() bool {
	_, err := exec.LookPath("port-pool")
	return err == nil
}

func portPoolConfigured(dir string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "port-pool.config.json"))
	if err != nil {
		return false
	}
	var parsed map[string]json.RawMessage
	if json.Unmarshal(raw, &parsed) != nil {
		return false
	}
	_, ok := parsed["schemaVersion"]
	return ok
}

// The whole "does port-pool run here" rule, in one place: provision and
// release must agree or a worktree keeps a port it never gives back.
// Externals are excluded because no provision ever ran.
func portPoolActiveFor(global globalConfig, id worktreeIdentity) bool {
	if id.IsExternal || global.PortPool == nil || !*global.PortPool {
		return false
	}
	return portPoolInstalled() && portPoolConfigured(id.Path)
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
