package main

// The control wire's client: how the cross-device verbs (send, bring,
// mirror, devices) reach the running app. The CLI is the engine for
// everything git, but another device is reached through the account,
// the hub socket and the one direct session per peer, which the
// running app holds and a second process must not dial beside it (the
// peer keeps one socket per device and would drop the app's). So these
// verbs ask the app, and the app shells this CLI back for each git
// step of the run.
//
// The app publishes its listener in <dataDir>/control.json
// (main/core/control/server.ts): a loopback port and a token minted at
// bind, in an owner-only file. The data dir is what names an app
// instance (flavor, dev profile), so the file this CLI resolves is the
// one app it may talk to. The wire is newline-delimited JSON: hello
// with the token, then one `req`, answered by `push` lines (progress)
// and one `res`.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

const controlFileName = "control.json"

type controlFile struct {
	Pid        int    `json:"pid"`
	Port       int    `json:"port"`
	Token      string `json:"token"`
	AppVersion string `json:"appVersion"`
}

type controlFrame struct {
	T       string          `json:"t"`
	ID      int             `json:"id,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Message string          `json:"message,omitempty"`
	Code    string          `json:"code,omitempty"`
	Channel string          `json:"channel,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// The app answers a hello at once, so a dial or a welcome that takes
// this long is not the app.
const controlHandshakeTimeout = 5 * time.Second

func appNotRunningErr() error {
	hint := "Open it (sm app), sign in, and try again."
	if flavor != "prod" {
		hint = "Start it with `pnpm dev` in a checkout, sign in, and try again."
	}
	return codedErrf("app-not-running",
		"The Shigoto no Mori app isn't running, and it is what reaches your other devices. %s", hint)
}

func readControlFile() *controlFile {
	raw, err := os.ReadFile(filepath.Join(dataDir(), controlFileName))
	if err != nil {
		return nil
	}
	var file controlFile
	if json.Unmarshal(raw, &file) != nil || file.Pid <= 0 || file.Port <= 0 || file.Token == "" {
		return nil
	}
	return &file
}

// One request over a fresh connection. onPush sees every broadcast the
// handler streams before its answer. The result is left raw for the
// caller to decode into its own shape.
func controlCall(channel string, input any, onPush func(channel string, payload json.RawMessage)) (json.RawMessage, error) {
	file := readControlFile()
	// A file left by a crash names a dead pid, or a port nothing (or
	// something else) listens on: both read as "not running", the second
	// through the dial or the hello below.
	if file == nil || !pidAlive(file.Pid) {
		return nil, appNotRunningErr()
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", file.Port), controlHandshakeTimeout)
	if err != nil {
		return nil, appNotRunningErr()
	}
	defer conn.Close()

	writer := json.NewEncoder(conn)
	reader := bufio.NewReaderSize(conn, 64*1024)
	readFrame := func() (*controlFrame, error) {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		var frame controlFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			return nil, err
		}
		return &frame, nil
	}

	_ = conn.SetDeadline(time.Now().Add(controlHandshakeTimeout))
	if err := writer.Encode(map[string]any{"t": "hello", "token": file.Token}); err != nil {
		return nil, appNotRunningErr()
	}
	welcome, err := readFrame()
	if err == nil && welcome.T == "refused" && welcome.Code == "busy" {
		// The app is there and said so. Any other refusal is a
		// control.json this listener didn't write.
		return nil, codedErrf("app-busy", "The app is serving as many %s commands as it takes at once. Try again in a moment.", binaryName)
	}
	if err != nil || welcome.T != "welcome" {
		return nil, appNotRunningErr()
	}
	// A transfer takes as long as it takes (a setup script, a large
	// tree), so nothing past the hello is on a clock.
	_ = conn.SetDeadline(time.Time{})
	vlog("control: connected to the app (v%s, pid %d)", file.AppVersion, file.Pid)

	request := map[string]any{"t": "req", "id": 1, "channel": channel}
	if input != nil {
		request["input"] = input
	}
	if err := writer.Encode(request); err != nil {
		return nil, errf("Lost the connection to the app: %v", err)
	}
	for {
		frame, err := readFrame()
		if err != nil {
			return nil, errf("Lost the connection to the app before it answered. Whatever it had started keeps running there: check the app, or `sm worktrees mirrors`.")
		}
		switch frame.T {
		case "push":
			if onPush != nil {
				onPush(frame.Channel, frame.Payload)
			}
		case "res":
			if frame.ID != 1 {
				continue
			}
			if !frame.OK {
				if frame.Code != "" {
					return nil, codedErrf(frame.Code, "%s", frame.Message)
				}
				return nil, errf("%s", frame.Message)
			}
			return frame.Result, nil
		}
	}
}

// controlCall with the answer decoded into out. The raw answer comes
// back too, for a --json run that passes the app's document through.
func controlInvoke(channel string, input any, out any, onPush func(string, json.RawMessage)) (json.RawMessage, error) {
	raw, err := controlCall(channel, input, onPush)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return nil, errf("The app answered %s with something this CLI can't read (%v). The two may be different versions.", channel, err)
	}
	return raw, nil
}
