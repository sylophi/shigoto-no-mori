package main

// The lifecycle runner's shell selection and environment, which must
// match the app's console runner (host/lib/scripts) so moving a run
// from one to the other changes nothing a script can see.

import (
	"encoding/json"
	"io"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestPasswdShellFor(t *testing.T) {
	passwd := strings.Join([]string{
		"# comment",
		"root:*:0:0:System Administrator:/var/root:/bin/sh",
		"fox:*:501:20:Fox:/Users/fox:/opt/homebrew/bin/fish",
		"short:line",
	}, "\n")
	if got := passwdShellFor(passwd, "501"); got != "/opt/homebrew/bin/fish" {
		t.Errorf("uid 501 = %q", got)
	}
	if got := passwdShellFor(passwd, "0"); got != "/bin/sh" {
		t.Errorf("uid 0 = %q", got)
	}
	if got := passwdShellFor(passwd, "999"); got != "" {
		t.Errorf("unknown uid = %q, want empty", got)
	}
}

// A GUI-spawned CLI can have no $SHELL; the account's login shell is
// the answer then, as a login shell, and /bin/sh only when there is
// none at all.
func TestResolveShellFallsBackToPasswd(t *testing.T) {
	saved := passwdShell
	t.Cleanup(func() { passwdShell = saved })

	t.Setenv("SHELL", "/bin/zsh")
	passwdShell = func() string { return "/usr/local/bin/fish" }
	if shell, args := resolveShell(); shell != "/bin/zsh" || !reflect.DeepEqual(args, []string{"-l", "-c"}) {
		t.Errorf("with $SHELL: %s %v", shell, args)
	}
	t.Setenv("SHELL", "")
	if shell, args := resolveShell(); shell != "/usr/local/bin/fish" || !reflect.DeepEqual(args, []string{"-l", "-c"}) {
		t.Errorf("passwd fallback: %s %v", shell, args)
	}
	passwdShell = func() string { return "" }
	if shell, args := resolveShell(); shell != "/bin/sh" || !reflect.DeepEqual(args, []string{"-c"}) {
		t.Errorf("no shell anywhere: %s %v", shell, args)
	}
}

func TestLifecycleEnv(t *testing.T) {
	t.Setenv("PAGER", "less")
	t.Setenv("COLORTERM", "")
	in := scriptEnvInputs{scriptName: "setup", worktree: worktreeIdentity{ID: "abc", Name: "fox", Path: "/w/fox"}}
	lookup := func(env []string, key string) string {
		value := ""
		for _, kv := range env {
			if k, v, _ := strings.Cut(kv, "="); k == key {
				value = v // exec keeps the last duplicate
			}
		}
		return value
	}

	saved := jsonMode
	t.Cleanup(func() { jsonMode = saved })
	jsonMode = false
	env := lifecycleEnv(in)
	for key, want := range map[string]string{
		"PAGER": "cat", "GIT_PAGER": "cat", "FORCE_COLOR": "1", "TERM": "xterm-256color",
		"SHIGOMORI_SCRIPT_NAME": "setup", "SHIGOMORI_WORKTREE_ID": "abc",
	} {
		if got := lookup(env, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if slices.Contains(env, "COLORTERM=truecolor") {
		t.Error("a terminal run claimed truecolor for the user's terminal")
	}
	jsonMode = true
	if got := lookup(lifecycleEnv(in), "COLORTERM"); got != "truecolor" {
		t.Errorf("--json COLORTERM = %q, want truecolor (the app's console)", got)
	}
}

// The app stops a CLI-run script by the pid on its "started" event, so
// the event must carry one and land before any of the run's output.
func TestLifecycleScriptStartedCarriesPidAheadOfOutput(t *testing.T) {
	saved := jsonMode
	t.Cleanup(func() { jsonMode = saved })
	jsonMode = true

	stdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = stdout })
	read := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(r)
		read <- string(data)
	}()

	in := scriptEnvInputs{scriptName: "setup", worktree: worktreeIdentity{ID: "abc", Name: "fox", Path: t.TempDir()}}
	code, runID := runLifecycleScript("echo hi", in, scriptSlot{Kind: "setup"})
	w.Close()
	os.Stdout = stdout
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}

	var kinds []string
	var pid float64
	for _, line := range strings.Split(strings.TrimSpace(<-read), "\n") {
		var doc map[string]any
		if err := json.Unmarshal([]byte(line), &doc); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if doc["runId"] != runID {
			t.Errorf("runId = %v, want %s", doc["runId"], runID)
		}
		kinds = append(kinds, doc["kind"].(string))
		if doc["kind"] == "started" {
			pid, _ = doc["pid"].(float64)
		}
	}
	if !reflect.DeepEqual(kinds, []string{"started", "data", "exit"}) {
		t.Errorf("event kinds = %v, want started, data, exit", kinds)
	}
	if pid <= 0 {
		t.Errorf("started event pid = %v, want the script's pid", pid)
	}
}
