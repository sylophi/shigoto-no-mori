package main

// sm agents: sessions bind (create, any command inside a worktree, an
// event from a session started in one), events move their state, the
// row derives agentWorking from them, and rm drops them. install edits
// a hooks file without disturbing the rest of it. Against real git in
// a temp SHIGOMORI_DATA_DIR.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// What the hooks run, as the installed binary would name itself (the
// test binary is cli.test).
func fakeHookBinary(t *testing.T) {
	saved := hookBinary
	hookBinary = func() string { return "/Applications/Shigoto no Mori.app/Contents/Resources/" + binaryName }
	t.Cleanup(func() { hookBinary = saved })
}

func sessionsOf(t *testing.T, worktreeID string) []agentSession {
	t.Helper()
	return agentSessionsFrom(readRegistryHints())[worktreeID]
}

func sendEvent(t *testing.T, ctx cliContext, name, session, extra string) {
	t.Helper()
	var event agentEvent
	payload := `{"hook_event_name":"` + name + `","session_id":"` + session + `"` + extra + `}`
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		t.Fatal(err)
	}
	if err := applyAgentEvent("claude", event); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func TestAgentSessionLifecycle(t *testing.T) {
	proj := autoPullSandbox(t)
	t.Setenv("CLAUDE_CODE_SESSION_ID", "s1")
	fox := createViaCmd(t, proj, "fox")
	if got := sessionsOf(t, fox.ID); len(got) != 1 || got[0].Session != "s1" || got[0].State != agentWorking {
		t.Fatalf("create didn't bind the session working: %+v", got)
	}
	row := buildWorktree(proj, fox, loadBuildContext(proj))
	if !row.AgentWorking || len(row.AgentSessions) != 1 {
		t.Fatalf("row of a worktree with a working session: %+v", row)
	}

	ctx := resolveContext(proj.Path, []project{proj})
	steps := []struct{ event, extra, want string }{
		{"Stop", "", agentIdle},
		{"PostToolUse", "", agentIdle}, // a late async PostToolUse can't revive a finished turn
		{"UserPromptSubmit", "", agentWorking},
		{"PermissionRequest", "", agentWaiting},
		{"PostToolUse", "", agentWorking},
		{"Notification", `,"notification_type":"permission_prompt"`, agentWorking},
		{"Notification", `,"notification_type":"idle_prompt"`, agentIdle},
	}
	for _, step := range steps {
		sendEvent(t, ctx, step.event, "s1", step.extra)
		if got := sessionsOf(t, fox.ID); len(got) != 1 || got[0].State != step.want {
			t.Fatalf("after %s%s: %+v, want %s", step.event, step.extra, got, step.want)
		}
	}
	if row := buildWorktree(proj, fox, loadBuildContext(proj)); row.AgentWorking {
		t.Fatalf("row says agentWorking with only an idle session")
	}

	// Running sm inside another worktree moves the binding there.
	owl := createViaCmd(t, proj, "owl")
	autoBindAgentSession(resolveContext(fox.Path, []project{proj}))
	if len(sessionsOf(t, fox.ID)) != 1 || len(sessionsOf(t, owl.ID)) != 0 {
		t.Fatalf("auto-bind inside fox didn't move the session from owl")
	}

	if code, err := cmdAgentsUnbind(nil); code != 0 || err != nil {
		t.Fatalf("unbind: %d, %v", code, err)
	}
	if got := sessionsOf(t, fox.ID); len(got) != 0 {
		t.Fatalf("unbind left the binding: %+v", got)
	}
	autoBindAgentSession(resolveContext(fox.Path, []project{proj}))

	sendEvent(t, ctx, "SessionEnd", "s1", "")
	if got := sessionsOf(t, fox.ID); len(got) != 0 {
		t.Fatalf("SessionEnd left the binding: %+v", got)
	}
}

func TestAgentEventBindsSessionStartedInWorktree(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := resolveContext(proj.Path, []project{proj})

	sendEvent(t, ctx, "UserPromptSubmit", "s2", `,"cwd":"`+proj.Path+`"`)
	if all := agentSessionsFrom(readRegistryHints()); len(all) != 0 {
		t.Fatalf("an event from the primary checkout bound a session: %+v", all)
	}
	sendEvent(t, ctx, "UserPromptSubmit", "s2", `,"cwd":"`+fox.Path+`"`)
	if got := sessionsOf(t, fox.ID); len(got) != 1 || got[0].State != agentWorking {
		t.Fatalf("an event from inside fox didn't bind it there: %+v", got)
	}
}

func TestAgentBindRefusesPrimaryAndRmDrops(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := resolveContext(proj.Path, []project{proj})

	if code, _ := cmdAgentsBind(ctx, []string{"primary", "--harness", "pi", "--session", "s3"}); code == 0 {
		t.Fatalf("binding the primary succeeded")
	}
	if code, err := cmdAgentsBind(ctx, []string{"fox", "--harness", "pi", "--session", "s3"}); code != 0 || err != nil {
		t.Fatalf("bind: %d, %v", code, err)
	}
	if code, err := cmdAgentsIdle(ctx, []string{"fox"}); code != 0 || err != nil {
		t.Fatalf("idle: %d, %v", code, err)
	}
	if got := sessionsOf(t, fox.ID); len(got) != 1 || got[0].Harness != "pi" || got[0].State != agentIdle {
		t.Fatalf("after bind and idle: %+v", got)
	}
	if _, err := execRemove(proj, fox, removeOptions{force: true, skipCleanup: true}); err != nil {
		t.Fatal(err)
	}
	if got := sessionsOf(t, fox.ID); len(got) != 0 {
		t.Fatalf("rm left the binding behind: %+v", got)
	}
}

func TestAgentsInstallKeepsTheRestOfTheFile(t *testing.T) {
	fakeHookBinary(t)
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	path := filepath.Join(dir, "settings.json")
	original := `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ]
  },
  "env": {
    "B": "1",
    "A": "2"
  }
}
`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	claude := *lookupHarness("claude")
	if st := claude.status(); st.Hooks != "missing" || !st.Detected {
		t.Fatalf("before install: %+v", st)
	}

	if code, err := cmdAgentsInstall([]string{"claude"}, true); code != 0 || err != nil {
		t.Fatalf("install: %d, %v", code, err)
	}
	if st := claude.status(); st.Hooks != "installed" || st.Trusted != nil {
		t.Fatalf("after install: %+v", st)
	}
	raw, _ := os.ReadFile(path)
	text := string(raw)
	if !strings.Contains(text, "say done") || strings.Index(text, `"model"`) > strings.Index(text, `"env"`) ||
		strings.Index(text, `"B"`) > strings.Index(text, `"A"`) {
		t.Fatalf("install disturbed the rest of the file:\n%s", text)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("install changed the file's mode to %v", info.Mode().Perm())
	}

	// Installing again replaces ours rather than adding a second set.
	if code, err := cmdAgentsInstall([]string{"claude"}, true); code != 0 || err != nil {
		t.Fatalf("reinstall: %d, %v", code, err)
	}
	doc, _ := readHooksDoc(path)
	if _, total := doc.ourEntries(claude); total != len(claude.install.hooks) {
		t.Fatalf("reinstall left %d entries, want %d", total, len(claude.install.hooks))
	}

	// An entry from another build of ours is outdated.
	doc.removeOurs(claude)
	doc.hooks.set("Stop", mustRaw(append(doc.groups("Stop"),
		mustRaw(map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "/old/" + binaryName + " agents event --harness claude"}}}))))
	if err := doc.write(false); err != nil {
		t.Fatal(err)
	}
	if st := claude.status(); st.Hooks != "outdated" {
		t.Fatalf("with a stale entry: %+v", st)
	}

	if code, err := cmdAgentsInstall([]string{"claude"}, false); code != 0 || err != nil {
		t.Fatalf("uninstall: %d, %v", code, err)
	}
	raw, _ = os.ReadFile(path)
	var back, want any
	_ = json.Unmarshal(raw, &back)
	_ = json.Unmarshal([]byte(original), &want)
	if string(mustRaw(back)) != string(mustRaw(want)) {
		t.Fatalf("uninstall didn't restore the file:\n%s", raw)
	}
}

// The hash Codex itself reports (app-server hooks/list) for these
// entries, so a change to either side's normalization shows up here.
func TestCodexHookHash(t *testing.T) {
	command := "'/tmp/smtest/smd' agents event --harness codex"
	cases := []struct {
		spec hookSpec
		want string
	}{
		{hookSpec{event: "PostToolUse", async: true}, "sha256:8a36bd1d01af3a0e74184d4f094708966f0bb85db44998fc5bc0963c122ecec6"},
		{hookSpec{event: "Stop"}, "sha256:0ab8b4a5da8de20af7339c783893a146bb80e9389c6237abde37015a9b31c840"},
	}
	for _, c := range cases {
		if got := codexHookHash(c.spec, command); got != c.want {
			t.Errorf("%s: %s, want %s", c.spec.event, got, c.want)
		}
	}
}

func TestCodexTrustStatus(t *testing.T) {
	fakeHookBinary(t)
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	codex := *lookupHarness("codex")
	if code, err := cmdAgentsInstall([]string{"codex"}, true); code != 0 || err != nil {
		t.Fatalf("install: %d, %v", code, err)
	}
	if st := codex.status(); st.Trusted == nil || *st.Trusted {
		t.Fatalf("fresh install reads as trusted: %+v", st)
	}
	keyPath, _ := filepath.EvalSymlinks(codex.hooksPath())
	var toml strings.Builder
	for _, spec := range codex.install.hooks {
		toml.WriteString(`[hooks.state."` + keyPath + ":" + snakeCase(spec.event) + `:0:0"]` + "\n")
		toml.WriteString(`trusted_hash = "` + codexHookHash(spec, codex.hookCommand()) + `"` + "\n\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(toml.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	if st := codex.status(); st.Trusted == nil || !*st.Trusted {
		t.Fatalf("trusted entries read as untrusted: %+v", st)
	}

	if code, err := cmdAgentsInstall([]string{"codex"}, false); code != 0 || err != nil {
		t.Fatalf("uninstall: %d, %v", code, err)
	}
	if _, err := os.Stat(codex.hooksPath()); !os.IsNotExist(err) {
		t.Fatalf("uninstall left an empty hooks.json behind")
	}
}

func TestAgentsInstallThroughSymlinkAndRefusesMalformed(t *testing.T) {
	fakeHookBinary(t)
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	dotfiles := filepath.Join(t.TempDir(), "hooks.json")
	if err := os.WriteFile(dotfiles, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "hooks.json")
	if err := os.Symlink(dotfiles, link); err != nil {
		t.Fatal(err)
	}
	for _, install := range []bool{true, false} {
		if code, err := cmdAgentsInstall([]string{"codex"}, install); code != 0 || err != nil {
			t.Fatalf("install %v: %d, %v", install, code, err)
		}
		if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("install %v replaced the symlink: %v", install, err)
		}
	}
	if raw, _ := os.ReadFile(dotfiles); strings.TrimSpace(string(raw)) != "{}" {
		t.Fatalf("uninstall left the linked file holding %s", raw)
	}

	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	malformed := `{"hooks":{"Stop":{"command":"say done"}}}`
	if err := os.WriteFile(link, []byte(malformed), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _ := cmdAgentsInstall([]string{"codex"}, true); code == 0 {
		t.Fatalf("install over a malformed hook list succeeded")
	}
	if raw, _ := os.ReadFile(link); string(raw) != malformed {
		t.Fatalf("a refused install still wrote: %s", raw)
	}
}
