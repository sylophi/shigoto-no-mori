package main

// The control wire's client against a scripted listener: what the CLI
// makes of each way the app can answer (or fail to). The app's own
// half, and both halves together, are test/control.mjs's.

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A loopback listener that plays the app: reads the hello and the
// request, then writes `reply` (one line per frame). Returns the port
// and a channel carrying the two lines it was sent.
func scriptedControlServer(t *testing.T, reply func(hello, req map[string]any) []map[string]any) (int, <-chan []map[string]any) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	seen := make(chan []map[string]any, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		readLine := func() map[string]any {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return nil
			}
			var doc map[string]any
			_ = json.Unmarshal(line, &doc)
			return doc
		}
		hello := readLine()
		writer := json.NewEncoder(conn)
		if hello == nil || hello["token"] != "good-token" {
			_ = writer.Encode(map[string]any{"t": "refused", "message": "bad token"})
			seen <- []map[string]any{hello}
			return
		}
		_ = writer.Encode(map[string]any{"t": "welcome", "appVersion": "1.2.3"})
		req := readLine()
		for _, frame := range reply(hello, req) {
			_ = writer.Encode(frame)
		}
		seen <- []map[string]any{hello, req}
	}()
	return listener.Addr().(*net.TCPAddr).Port, seen
}

func writeControlFile(t *testing.T, file controlFile) {
	t.Helper()
	raw, _ := json.Marshal(file)
	if err := os.WriteFile(filepath.Join(dataDir(), controlFileName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestControlCallStreamsPushesThenTheResult(t *testing.T) {
	sandboxDataDir(t)
	port, seen := scriptedControlServer(t, func(_, req map[string]any) []map[string]any {
		return []map[string]any{
			{"t": "push", "channel": "sync:pullProgress", "payload": map[string]any{"step": "capture"}},
			// Another call's answer on the same socket is not ours.
			{"t": "res", "id": 99, "ok": true, "result": "someone else's"},
			{"t": "push", "channel": "sync:pullProgress", "payload": map[string]any{"step": "transfer"}},
			{"t": "res", "id": req["id"], "ok": true, "result": map[string]any{"session": "sync_1"}},
		}
	})
	writeControlFile(t, controlFile{Pid: os.Getpid(), Port: port, Token: "good-token", AppVersion: "1.2.3"})

	var steps []string
	var result struct {
		Session string `json:"session"`
	}
	_, err := controlInvoke("control:send", map[string]any{"projectId": "p"}, &result, func(channel string, payload json.RawMessage) {
		var progress syncProgress
		_ = json.Unmarshal(payload, &progress)
		steps = append(steps, channel+"/"+progress.Step)
	})
	if err != nil {
		t.Fatalf("controlInvoke: %v", err)
	}
	if result.Session != "sync_1" {
		t.Errorf("result = %+v, want the answer to our own request id", result)
	}
	if got := strings.Join(steps, " "); got != "sync:pullProgress/capture sync:pullProgress/transfer" {
		t.Errorf("pushes = %q", got)
	}
	lines := <-seen
	if lines[1]["channel"] != "control:send" || lines[1]["t"] != "req" {
		t.Errorf("request line = %v", lines[1])
	}
	if input, _ := lines[1]["input"].(map[string]any); input["projectId"] != "p" {
		t.Errorf("request input = %v", lines[1]["input"])
	}
}

func TestControlCallCarriesTheAppsErrorCode(t *testing.T) {
	sandboxDataDir(t)
	port, _ := scriptedControlServer(t, func(_, req map[string]any) []map[string]any {
		return []map[string]any{
			{"t": "res", "id": req["id"], "ok": false, "message": "Several devices could take part.", "code": "ambiguous-device"},
		}
	})
	writeControlFile(t, controlFile{Pid: os.Getpid(), Port: port, Token: "good-token"})
	_, err := controlCall("control:send", nil, nil)
	if err == nil || errorKindOf(err) != "ambiguous-device" || exitCodeOf(err) != 1 {
		t.Fatalf("err = %v (kind %q, exit %d), want coded ambiguous-device, exit 1", err, errorKindOf(err), exitCodeOf(err))
	}
	if err.Error() != "Several devices could take part." {
		t.Errorf("message = %q, want the app's own words", err.Error())
	}
}

func TestControlCallReadsEveryDeadEndAsAppNotRunning(t *testing.T) {
	sandboxDataDir(t)
	notRunning := func(label string) {
		t.Helper()
		_, err := controlCall("control:devices", nil, nil)
		if errorKindOf(err) != "app-not-running" {
			t.Errorf("%s: err = %v, want app-not-running", label, err)
		}
	}
	notRunning("no control.json")

	if err := os.WriteFile(filepath.Join(dataDir(), controlFileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	notRunning("an unreadable control.json")

	// A pid far past any live one: the file a crashed app left behind.
	writeControlFile(t, controlFile{Pid: 1<<22 - 7, Port: 1, Token: "good-token"})
	notRunning("a dead pid")

	// A live pid whose port nothing listens on.
	dead, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadPort := dead.Addr().(*net.TCPAddr).Port
	dead.Close()
	writeControlFile(t, controlFile{Pid: os.Getpid(), Port: deadPort, Token: "good-token"})
	notRunning("a dead port")

	// A listener that refuses the token: another app instance's port,
	// or a file left from an earlier bind.
	port, _ := scriptedControlServer(t, func(_, _ map[string]any) []map[string]any { return nil })
	writeControlFile(t, controlFile{Pid: os.Getpid(), Port: port, Token: "stale-token"})
	notRunning("a refused token")
}

// An app at its connection cap is running: the refusal names itself so
// the CLI doesn't tell the user to open an app that is already open.
func TestControlCallTellsABusyAppFromAnAbsentOne(t *testing.T) {
	sandboxDataDir(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = json.NewEncoder(conn).Encode(map[string]any{"t": "refused", "code": "busy", "message": "too many control connections"})
	}()
	writeControlFile(t, controlFile{Pid: os.Getpid(), Port: listener.Addr().(*net.TCPAddr).Port, Token: "good-token"})
	_, err = controlCall("control:devices", nil, nil)
	if errorKindOf(err) != "app-busy" {
		t.Fatalf("err = %v (kind %q), want app-busy", err, errorKindOf(err))
	}
}

func TestCheckDeviceFlagsRefusesABlankDevice(t *testing.T) {
	for _, args := range [][]string{{"--to", ""}, {"--from", "  "}} {
		parsed, err := parseCmdArgs(args, transferSpec())
		if err != nil {
			t.Fatal(err)
		}
		if err := checkDeviceFlags(parsed); exitCodeOf(err) != 2 {
			t.Errorf("%q: err = %v, want a usage error", args, err)
		}
	}
	parsed, _ := parseCmdArgs([]string{"--to", "Studio"}, transferSpec())
	if err := checkDeviceFlags(parsed); err != nil {
		t.Errorf("a named device: %v", err)
	}
	bare, _ := parseCmdArgs(nil, transferSpec())
	if err := checkDeviceFlags(bare); err != nil {
		t.Errorf("no device flag: %v", err)
	}
}

func TestControlCallSaysSoWhenTheAppGoesAwayMidCall(t *testing.T) {
	sandboxDataDir(t)
	port, _ := scriptedControlServer(t, func(_, _ map[string]any) []map[string]any {
		return []map[string]any{
			{"t": "push", "channel": "sync:pullProgress", "payload": map[string]any{"step": "transfer"}},
		}
	})
	writeControlFile(t, controlFile{Pid: os.Getpid(), Port: port, Token: "good-token"})
	_, err := controlCall("control:send", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "keeps running there") {
		t.Fatalf("err = %v, want the lost-connection message", err)
	}
	if errorKindOf(err) == "app-not-running" {
		t.Error("a call that started must not read as 'the app isn't running'")
	}
}

func TestTransferOptionsValidation(t *testing.T) {
	parse := func(args ...string) parsedArgs {
		t.Helper()
		parsed, err := parseCmdArgs(args, transferSpec())
		if err != nil {
			t.Fatalf("parse %v: %v", args, err)
		}
		return parsed
	}
	for _, bad := range [][]string{
		{"--leave-out", "some"},
		{"--source", "burn"},
		{"--setup", "--no-setup"},
	} {
		if _, err := transferOptions(parse(bad...), "", false); exitCodeOf(err) != 2 {
			t.Errorf("%v: err = %v, want a usage error", bad, err)
		}
	}
	// The saved rule is the absent default, not a value to spell.
	if _, err := transferOptions(parse("--leave-out", "preset"), "", false); exitCodeOf(err) != 2 {
		t.Errorf("--leave-out preset: err = %v, want a usage error", err)
	}
	// A mirror keeps its source, so a fate for it is a contradiction.
	if _, err := transferOptions(parse("--source", "teardown"), "", true); exitCodeOf(err) != 2 {
		t.Errorf("--source on a mirror: err = %v, want a usage error", err)
	}

	input, err := transferOptions(parse("--leave-out", "gitignored", "--no-setup", "--source", "shelve"), "Studio Mac", false)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"device": "Studio Mac", "leaveOut": "gitignored", "setup": false, "source": "shelve"}
	if len(input) != len(want) {
		t.Fatalf("input = %v, want %v", input, want)
	}
	for key, value := range want {
		if input[key] != value {
			t.Errorf("input[%q] = %v, want %v", key, input[key], value)
		}
	}
	// Nothing asked, nothing sent: the app applies the project's preset
	// and the rule's own setup default.
	if bare, _ := transferOptions(parse(), "", false); len(bare) != 0 {
		t.Errorf("bare options = %v, want none", bare)
	}
}

func TestTransferCaveats(t *testing.T) {
	var clean controlTransferResult
	_ = json.Unmarshal([]byte(`{"captured":true,"dirtyApplied":true,"files":{"crossed":true,"conflicts":0},"source":{"fate":"teardown","done":true}}`), &clean)
	if got := clean.caveats(); len(got) != 0 {
		t.Errorf("clean run caveats = %v", got)
	}
	var rough controlTransferResult
	_ = json.Unmarshal([]byte(`{"captured":true,"dirtyApplied":false,"files":{"crossed":false,"conflicts":0,"error":"peer went away"},"source":{"fate":"teardown","done":false,"error":"it changed after the send"}}`), &rough)
	got := strings.Join(rough.caveats(), "\n")
	for _, want := range []string{"exist only on the source", "peer went away", "was not removed: it changed after the send"} {
		if !strings.Contains(got, want) {
			t.Errorf("caveats missing %q:\n%s", want, got)
		}
	}
}
