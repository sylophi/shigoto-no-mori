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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"slices"
	"strings"
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
	// The permission prompts it waits on, oldest first, each its call
	// (toolWait) and what it asks (waitAsk).
	Waits []string `json:"waits,omitempty"`
	// What the session is about: its custom title, else its first
	// prompt.
	Title string `json:"title,omitempty"`
	// What it waits on while waiting: the newest open prompt's tool, and
	// the question it asks or the one input that says what the call does
	// (waitNeed). The app says which kind of prompt by the tool.
	Tool string `json:"tool,omitempty"`
	Need string `json:"need,omitempty"`
	// The message its last turn ended on, while idle.
	Message string `json:"message,omitempty"`
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
	// Whether its subagents' events name the subagent by agent_id, the
	// thread id the subagent's own shell binds under (Codex). A Claude
	// Code subagent works within its parent's session.
	subagentIDs bool
	// The command that resumes a session, given its id.
	resume  string
	install hookInstall
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
// bound elsewhere keeps its state and waits, and a new one starts as
// given.
func bindAgentSession(session agentSession, worktreeID string) error {
	return updateAgentSessions(func(m map[string][]agentSession) bool {
		at, i := findAgentSession(m, session.Harness, session.Session)
		if at == worktreeID {
			return false
		}
		if i >= 0 {
			session = m[at][i]
			m[at] = slices.Delete(m[at], i, i+1)
		} else {
			session.At = time.Now().UnixMilli()
		}
		m[worktreeID] = append(m[worktreeID], session)
		return true
	})
}

// A session bound outside a hook: working, since it binds from a
// command it runs mid-turn, but only when its harness has the hooks
// that will report the turn's end. Without them it would read working
// for good.
func newSession(harnessID, session string) agentSession {
	state := agentIdle
	if h := lookupHarness(harnessID); h != nil && h.status().Hooks == "installed" {
		state = agentWorking
	}
	return agentSession{Harness: harnessID, Session: session, State: state}
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
	if err := bindAgentSession(newSession(harnessID, session), id); err != nil {
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
	if err := bindAgentSession(newSession(harnessID, session), worktreeID); err != nil {
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
	case "bind":
		return withContext(cmdAgentsBind, args[1:])
	case "idle":
		return withContext(cmdAgentsIdle, args[1:])
	case "resume":
		return withContext(cmdAgentsResume, args[1:])
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
		return 2, usageErrf("Unknown subcommand %q. Usage: %s agents <bind|unbind|idle|resume|install|uninstall|status> [args]", args[0], binaryName)
	}
}

// A subcommand that targets a worktree, which takes the context.
func withContext(run func(cliContext, []string) (int, error), args []string) (int, error) {
	ctx, err := loadContext()
	if err != nil {
		return 1, err
	}
	return run(ctx, args)
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
	if err := bindAgentSession(newSession(harnessID, session), id.ID); err != nil {
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
			if s := &m[id.ID][i]; s.State != agentIdle {
				s.State, s.At, s.Waits, s.Tool, s.Need = agentIdle, now, nil, "", ""
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

// sm agents resume [<name>] --harness <id> --session <id>: the
// session's own CLI picks it up again in the worktree, in the user's
// terminal. A harness finds a session by its id from any directory.
func cmdAgentsResume(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.strings["harness"] = []string{}
	spec.strings["session"] = []string{}
	parsed, target, err := parseWorktreeArgs(ctx, args, spec, false)
	if err != nil {
		return exitCodeOf(err), err
	}
	harnessID, session := parsed.strings["harness"], parsed.strings["session"]
	if harnessID == "" || session == "" {
		return 2, usageErrf("--harness and --session are required.")
	}
	h := lookupHarness(harnessID)
	if h == nil || h.resume == "" {
		return 1, errf("Don't know how to resume a %s session", harnessID)
	}
	if err := launchInTerminal(h.resume+" "+shellQuote(session), target.worktree.Path); err != nil {
		return 1, err
	}
	emitOrOut(map[string]any{"ok": true}, greenOut("resumed "+harnessID+" session "+shortSession(session)+" in "+target.worktree.Name))
	return 0, nil
}

// What a harness hands its hooks on stdin: the fields Claude Code and
// Codex share, Notification's type, a Codex subagent's own thread id,
// the tool a permission prompt or a tool's end is about, the prompt
// (with the session's custom title, Claude Code) a turn starts from,
// and the message it ends on.
type agentEvent struct {
	Name             string          `json:"hook_event_name"`
	Session          string          `json:"session_id"`
	Cwd              string          `json:"cwd"`
	NotificationType string          `json:"notification_type"`
	AgentID          string          `json:"agent_id"`
	ToolName         string          `json:"tool_name"`
	ToolInput        json.RawMessage `json:"tool_input"`
	Prompt           string          `json:"prompt"`
	SessionTitle     string          `json:"session_title"`
	LastMessage      string          `json:"last_assistant_message"`
}

// One permission prompt, as the tool call it asks about. The prompt
// carries no call id, so the call is its tool and input, which its
// PostToolUse repeats. A question's PostToolUse adds the answers to
// it, so those are left out.
func toolWait(event agentEvent) string {
	var input any
	_ = json.Unmarshal(event.ToolInput, &input)
	if fields, ok := input.(map[string]any); ok && event.ToolName == "AskUserQuestion" {
		delete(fields, "answers")
		delete(fields, "annotations")
	}
	sum := sha256.Sum256(append([]byte(event.ToolName+"\x00"), mustRaw(input)...))
	return hex.EncodeToString(sum[:8])
}

// One open prompt as Waits keeps it: its call, tab, its tool, tab,
// what it asks. clipLine folds whitespace, so no tab is in the text.
func waitEntry(event agentEvent) string {
	return toolWait(event) + "\t" + event.ToolName + "\t" + waitNeed(event)
}

// An entry's call, and its tool and what it asks (none for an entry
// stored by an older build, which kept the call alone).
func waitAsk(entry string) (call, tool, need string) {
	call, rest, _ := strings.Cut(entry, "\t")
	tool, need, _ = strings.Cut(rest, "\t")
	return call, tool, need
}

// How long the text a session keeps may run, in runes: a line for a
// title or a prompt's call, a few for a closing message.
const (
	agentLineMax    = 120
	agentMessageMax = 400
)

// What a permission prompt asks, in a line: the question, or the one
// input that says what the call does (a command, a file, a URL), a
// path inside the session's cwd (the worktree) relative to it. Empty
// when nothing says more than the tool (a plan to review).
func waitNeed(event agentEvent) string {
	var input struct {
		Questions []struct {
			Question string `json:"question"`
		} `json:"questions"`
		Command  string `json:"command"`
		FilePath string `json:"file_path"`
		URL      string `json:"url"`
		Path     string `json:"path"`
		Pattern  string `json:"pattern"`
	}
	_ = json.Unmarshal(event.ToolInput, &input)
	if len(input.Questions) > 0 {
		return clipLine(input.Questions[0].Question, agentLineMax)
	}
	for _, v := range []string{input.Command, input.FilePath, input.URL, input.Path, input.Pattern} {
		if v == "" {
			continue
		}
		if rel, ok := strings.CutPrefix(v, strings.TrimSuffix(event.Cwd, "/")+"/"); ok && event.Cwd != "" {
			v = rel
		}
		return clipLine(v, agentLineMax)
	}
	return ""
}

// Text on one line, whitespace runs folded to a space, cut to max
// runes with an ellipsis.
func clipLine(text string, max int) string {
	return truncateRunes(strings.Join(strings.Fields(text), " "), max)
}

// Moves a session through one event: whether that changed it, and
// whether its binding goes. A session waits while any permission
// prompt is open, and a tool's end closes only its own prompt: tools
// run side by side, and PostToolUse, installed async, can land after a
// later prompt or after the turn's Stop. It also keeps what the app
// says of the session: its title, what the newest prompt asks, and the
// message the last turn ended on.
func (s *agentSession) apply(event agentEvent) (changed, unbind bool) {
	next := *s
	switch event.Name {
	case "UserPromptSubmit":
		next.State, next.Waits, next.Message = agentWorking, nil, ""
		if event.SessionTitle != "" {
			next.Title = clipLine(event.SessionTitle, agentLineMax)
		} else if next.Title == "" {
			next.Title = clipLine(event.Prompt, agentLineMax)
		}
	case "PermissionRequest":
		next.State, next.Waits = agentWaiting, append(slices.Clone(s.Waits), waitEntry(event))
	case "PostToolUse", "PostToolUseFailure":
		// Nearly every tool's end, with no prompt open: no need to hash
		// its input (a whole file, for a Write).
		if len(s.Waits) == 0 {
			return false, false
		}
		call := toolWait(event)
		i := slices.IndexFunc(s.Waits, func(entry string) bool {
			c, _, _ := waitAsk(entry)
			return c == call
		})
		if i < 0 {
			return false, false
		}
		next.Waits = slices.Delete(slices.Clone(s.Waits), i, i+1)
		if len(next.Waits) == 0 {
			next.State = agentWorking
		}
	case "Notification":
		// Claude Code's "waiting for your input" nudge, a minute after a
		// turn ends, and the only one that follows an interrupt.
		if event.NotificationType != "idle_prompt" {
			return false, false
		}
		next.State, next.Waits = agentIdle, nil
	case "Stop", "StopFailure", "Interrupt":
		next.State, next.Waits = agentIdle, nil
		if event.LastMessage != "" {
			next.Message = clipLine(event.LastMessage, agentMessageMax)
		}
	case "SessionEnd", "SubagentStop":
		return true, true
	default:
		return false, false
	}
	// What it waits on is the newest prompt still open, for as long as
	// the waiting lasts.
	next.Tool, next.Need = "", ""
	if next.State == agentWaiting && len(next.Waits) > 0 {
		_, next.Tool, next.Need = waitAsk(next.Waits[len(next.Waits)-1])
	}
	if next.State == s.State && slices.Equal(next.Waits, s.Waits) &&
		next.Title == s.Title && next.Tool == s.Tool && next.Need == s.Need && next.Message == s.Message {
		return false, false
	}
	if next.State != s.State {
		next.At = time.Now().UnixMilli()
	}
	*s = next
	return true, false
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
	key := event.Session
	if h := lookupHarness(harnessID); h != nil && h.subagentIDs && event.AgentID != "" {
		key = event.AgentID
	} else if event.Name == "SubagentStop" {
		// The parent's session id: its subagent ending isn't its end.
		return nil
	}
	sessions := agentSessionsFrom(readRegistryHints())
	if at, i := findAgentSession(sessions, harnessID, key); at != "" {
		if changed, _ := sessions[at][i].apply(event); !changed {
			return nil
		}
	} else {
		// An unbound session started in a managed worktree belongs to it.
		session := agentSession{Harness: harnessID, Session: key}
		if changed, unbind := session.apply(event); !changed || unbind {
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
		return bindAgentSession(session, current.worktree.ID)
	}
	return updateAgentSessions(func(m map[string][]agentSession) bool {
		at, i := findAgentSession(m, harnessID, key)
		if at == "" {
			return false
		}
		changed, unbind := m[at][i].apply(event)
		if unbind {
			m[at] = slices.Delete(m[at], i, i+1)
		}
		return changed
	})
}

func shortSession(session string) string {
	if len(session) > 8 {
		return session[:8]
	}
	return session
}
