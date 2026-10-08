package main

// sm agents: the bridge between coding agents' harnesses (Claude Code,
// Codex, any other that calls in) and the worktrees they work in. A
// harness session is bound to one worktree, and the harness's hooks
// report the session's state through `sm agents event`. The app files a
// worktree on its "Agent working" shelf while any session bound to it
// is working (agentWorkingFlag).
//
// A session binds itself: any command run inside a managed worktree
// from a supported harness's shell (whose env names the session) binds
// that session there, `create` binds it to the new worktree, and an
// event from an unbound session whose cwd is a managed worktree binds
// it to that one. `sm agents bind` does it explicitly.
//
// The bindings live in registry.json under agentSessionsKey, keyed by
// worktree id like the other marks (worktreeMarkKeys), so rm, move and
// project remove carry or drop them with the rest.

import (
	"encoding/json"
	"io"
	"os"
	"slices"
	"time"
)

// One session bound to a worktree. Harness is "claude", "codex", or
// whatever a harness without built-in support names itself.
type agentSession struct {
	Harness string `json:"harness"`
	Session string `json:"session"`
	State   string `json:"state"`
	// When the state last changed, in ms.
	At int64 `json:"at"`
}

// A session's states: working through a turn, waiting on the user
// mid-turn (a permission prompt), or idle (the turn ended).
const (
	agentWorking = "working"
	agentWaiting = "waiting"
	agentIdle    = "idle"
)

const agentSessionsKey = "agentSessions"

// The harnesses `sm agents` knows: the env var their shells carry the
// session id in (the same id their hooks receive as session_id), and
// how to install their hooks (agents_install.go).
type harness struct {
	id, label  string
	sessionEnv string
	install    hookInstall
}

func lookupHarness(id string) *harness {
	for i := range harnesses {
		if harnesses[i].id == id {
			return &harnesses[i]
		}
	}
	return nil
}

// The session the calling process runs in, from its env. A harness run
// inside another one's shell carries both vars, and the inner one is
// unknowable, so the table order decides.
func sessionFromEnv() (harnessID, session string) {
	for _, h := range harnesses {
		if s := os.Getenv(h.sessionEnv); s != "" {
			return h.id, s
		}
	}
	return "", ""
}

func agentSessionsFrom(all map[string]json.RawMessage) map[string][]agentSession {
	m := map[string][]agentSession{}
	if err := decodeKey(registryPath(), agentSessionsKey, all[agentSessionsKey], &m); err != nil {
		noteRegistryTrouble(err)
		return map[string][]agentSession{}
	}
	return m
}

// Whether any of a worktree's sessions is working: what the agent-
// working shelf takes.
func anyWorking(sessions []agentSession) bool {
	return slices.ContainsFunc(sessions, func(s agentSession) bool { return s.State == agentWorking })
}

// Read-modify-write of the bindings under the registry lock. fn edits
// the map in place and reports whether it changed anything, so an
// unchanged map writes nothing.
func updateAgentSessions(fn func(m map[string][]agentSession) bool) error {
	return updateRegistryKey(agentSessionsKey, func(raw json.RawMessage) (any, error) {
		m := map[string][]agentSession{}
		if err := decodeKey(registryPath(), agentSessionsKey, raw, &m); err != nil {
			return nil, err
		}
		if !fn(m) {
			return nil, nil
		}
		for id, list := range m {
			if len(list) == 0 {
				delete(m, id)
			}
		}
		return m, nil
	})
}

// Where a session is bound, and its entry there.
func findAgentSession(m map[string][]agentSession, harnessID, session string) (string, int) {
	for id, list := range m {
		for i, s := range list {
			if s.Harness == harnessID && s.Session == session {
				return id, i
			}
		}
	}
	return "", -1
}

// Binds a session to a worktree, moving it off any other. A session
// already bound there keeps its state; a new one starts in state.
func bindAgentSession(harnessID, session, worktreeID, state string) error {
	return updateAgentSessions(func(m map[string][]agentSession) bool {
		at, i := findAgentSession(m, harnessID, session)
		if at == worktreeID {
			return false
		}
		if i >= 0 {
			state = m[at][i].State
			m[at] = slices.Delete(m[at], i, i+1)
		}
		m[worktreeID] = append(m[worktreeID], agentSession{
			Harness: harnessID, Session: session, State: state, At: time.Now().UnixMilli(),
		})
		return true
	})
}

// The automatic binding run() does before a command: a session's shell
// running sm inside a managed worktree binds the session there. Checked
// against a plain read first, so the common case (already bound here)
// takes no lock. Best-effort: binding is never the command's point.
func autoBindAgentSession(ctx cliContext) {
	harnessID, session := sessionFromEnv()
	if session == "" || ctx.current == nil || !shelfable(ctx.current.worktree) {
		return
	}
	id := ctx.current.worktree.ID
	if at, _ := findAgentSession(agentSessionsFrom(readRegistryHints()), harnessID, session); at == id {
		return
	}
	if err := bindAgentSession(harnessID, session, id, agentWorking); err != nil {
		vlog("[agents] bind: %v", err)
	}
}

// create's binding: the session that made the worktree works in it.
// Returns the worktree's sessions once bound, for its row.
func bindAgentSessionToNew(worktreeID string) []agentSession {
	harnessID, session := sessionFromEnv()
	if session == "" {
		return nil
	}
	if err := bindAgentSession(harnessID, session, worktreeID, agentWorking); err != nil {
		note(yellowErr("warning:") + " couldn't bind this agent session to it: " + err.Error())
		return nil
	}
	return agentSessionsFrom(readRegistryHints())[worktreeID]
}

func cmdAgents(_ cliContext, args []string) (int, error) {
	if len(args) == 0 {
		out(namespaceHelp("agents"))
		return 0, nil
	}
	switch args[0] {
	case "bind", "idle":
		ctx, err := loadContext()
		if err != nil {
			return 1, err
		}
		if args[0] == "bind" {
			return cmdAgentsBind(ctx, args[1:])
		}
		return cmdAgentsIdle(ctx, args[1:])
	case "unbind":
		return cmdAgentsUnbind(args[1:])
	case "event":
		return cmdAgentsEvent(args[1:])
	case "install":
		return cmdAgentsInstall(args[1:], true)
	case "uninstall":
		return cmdAgentsInstall(args[1:], false)
	case "status":
		return cmdAgentsStatus(args[1:])
	default:
		return 2, usageErrf("Unknown subcommand %q. Usage: %s agents <bind|unbind|idle|install|uninstall|status> [args]", args[0], binaryName)
	}
}

// sm agents bind [<name>] [--harness <id> --session <id>]
func cmdAgentsBind(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.strings["harness"] = []string{}
	spec.strings["session"] = []string{}
	parsed, target, err := parseWorktreeArgs(ctx, args, spec, false)
	if err != nil {
		return exitCodeOf(err), err
	}
	harnessID, session, err := sessionArgs(parsed, "bind")
	if err != nil {
		return exitCodeOf(err), err
	}
	id := target.worktree
	if !shelfable(id) {
		return 1, errf("Only managed worktrees can be bound to an agent session, not the primary checkout or an external one")
	}
	if err := bindAgentSession(harnessID, session, id.ID, agentWorking); err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "worktree": buildWorktree(target.proj, id, loadBuildContext(target.proj))})
		return 0, nil
	}
	out(greenOut("bound " + harnessID + " session " + shortSession(session) + " to " + id.Name))
	return 0, nil
}

// The session --harness and --session name, or the calling shell's.
func sessionArgs(parsed parsedArgs, verb string) (harnessID, session string, err error) {
	harnessID, session = parsed.strings["harness"], parsed.strings["session"]
	if (harnessID == "") != (session == "") {
		return "", "", usageErrf("--harness and --session go together.")
	}
	if session == "" {
		harnessID, session = sessionFromEnv()
	}
	if session == "" {
		return "", "", errf("No agent session to %s: run this from a supported harness's shell, or pass --harness and --session", verb)
	}
	return harnessID, session, nil
}

// sm agents unbind [--harness <id> --session <id>]: the session is
// bound nowhere until a command binds it again.
func cmdAgentsUnbind(args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{strings: map[string][]string{"harness": {}, "session": {}}})
	if err != nil {
		return exitCodeOf(err), err
	}
	harnessID, session, err := sessionArgs(parsed, "unbind")
	if err != nil {
		return exitCodeOf(err), err
	}
	unbound := false
	err = updateAgentSessions(func(m map[string][]agentSession) bool {
		at, i := findAgentSession(m, harnessID, session)
		if at == "" {
			return false
		}
		m[at] = slices.Delete(m[at], i, i+1)
		unbound = true
		return true
	})
	if err != nil {
		return 1, err
	}
	line := harnessID + " session " + shortSession(session) + " wasn't bound"
	if unbound {
		line = greenOut("unbound " + harnessID + " session " + shortSession(session))
	}
	emitOrOut(map[string]any{"ok": true, "unbound": unbound}, line)
	return 0, nil
}

// sm agents idle [<name>]: every session bound to the worktree goes
// idle. For a turn whose end no hook reported (Claude Code fires none
// on an interrupt): the app's "Agent working" footer verb runs it.
func cmdAgentsIdle(ctx cliContext, args []string) (int, error) {
	_, target, err := parseWorktreeArgs(ctx, args, worktreeTargetSpec(), false)
	if err != nil {
		return exitCodeOf(err), err
	}
	id := target.worktree
	now := time.Now().UnixMilli()
	err = updateAgentSessions(func(m map[string][]agentSession) bool {
		changed := false
		for i := range m[id.ID] {
			if m[id.ID][i].State != agentIdle {
				m[id.ID][i].State, m[id.ID][i].At = agentIdle, now
				changed = true
			}
		}
		return changed
	})
	if err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "worktree": buildWorktree(target.proj, id, loadBuildContext(target.proj))})
		return 0, nil
	}
	out(greenOut("agent sessions idle in " + id.Name))
	return 0, nil
}

// What a harness hands its hooks on stdin: the fields every event
// carries in both Claude Code and Codex, plus Notification's type.
type agentEvent struct {
	Name             string `json:"hook_event_name"`
	Session          string `json:"session_id"`
	Cwd              string `json:"cwd"`
	NotificationType string `json:"notification_type"`
}

// The state an event puts its session in. "" leaves it alone, and
// unbind drops the binding. PostToolUse only ends a wait (the tool ran,
// so its permission prompt was answered): it fires on every tool, and,
// installed async, can land after the turn's Stop.
func agentEventState(event agentEvent, current string) (state string, unbind bool) {
	switch event.Name {
	case "UserPromptSubmit":
		return agentWorking, false
	case "PostToolUse":
		if current == agentWaiting {
			return agentWorking, false
		}
	case "PermissionRequest":
		return agentWaiting, false
	case "Notification":
		// Claude Code's "waiting for your input" nudge, a minute after a
		// turn ends, and the only one that follows an interrupt.
		if event.NotificationType == "idle_prompt" {
			return agentIdle, false
		}
	case "Stop", "StopFailure", "Interrupt":
		return agentIdle, false
	case "SessionEnd":
		return "", true
	}
	return "", false
}

// sm agents event --harness <id>: what the installed hooks run, one
// lifecycle event as JSON on stdin. Always exits 0 with nothing on
// stdout: a hook's exit code and output are instructions to its
// harness (2 blocks the action), and a missed state change must never
// be one.
func cmdAgentsEvent(args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{strings: map[string][]string{"harness": {}}})
	harnessID := parsed.strings["harness"]
	if err != nil || harnessID == "" {
		note("Usage: " + binaryName + " agents event --harness <id> (the event on stdin)")
		return 0, nil
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		vlog("[agents] event: %v", err)
		return 0, nil
	}
	var event agentEvent
	if err := json.Unmarshal(raw, &event); err != nil || event.Session == "" {
		vlog("[agents] event: unreadable payload")
		return 0, nil
	}
	if err := applyAgentEvent(harnessID, event); err != nil {
		vlog("[agents] event: %v", err)
	}
	return 0, nil
}

// Judged against a plain read first, so the common event that changes
// nothing (PostToolUse mid-turn) takes no lock and loads no projects.
func applyAgentEvent(harnessID string, event agentEvent) error {
	sessions := agentSessionsFrom(readRegistryHints())
	if at, i := findAgentSession(sessions, harnessID, event.Session); at != "" {
		state, unbind := agentEventState(event, sessions[at][i].State)
		if !unbind && (state == "" || state == sessions[at][i].State) {
			return nil
		}
	} else {
		// An unbound session started in a managed worktree belongs to it.
		state, unbind := agentEventState(event, "")
		if state == "" || unbind {
			return nil
		}
		projects, err := loadMergedProjects()
		if err != nil {
			return err
		}
		cwd := event.Cwd
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		current := resolveContext(cwd, projects).current
		if current == nil || !shelfable(current.worktree) {
			return nil
		}
		return bindAgentSession(harnessID, event.Session, current.worktree.ID, state)
	}
	return updateAgentSessions(func(m map[string][]agentSession) bool {
		at, i := findAgentSession(m, harnessID, event.Session)
		if at == "" {
			return false
		}
		state, unbind := agentEventState(event, m[at][i].State)
		if unbind {
			m[at] = slices.Delete(m[at], i, i+1)
			return true
		}
		if state == "" || state == m[at][i].State {
			return false
		}
		m[at][i].State, m[at][i].At = state, time.Now().UnixMilli()
		return true
	})
}

func shortSession(session string) string {
	if len(session) > 8 {
		return session[:8]
	}
	return session
}
