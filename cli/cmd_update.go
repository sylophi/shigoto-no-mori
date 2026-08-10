package main

// sm update -- update the app (and with it this CLI, a symlink into
// the bundle) from the terminal. The CLI never downloads anything
// itself: it drives the app's own auto-updater over the on-disk bridge
// in the state root, mirroring main/electron/updaterBridge.ts:
//   updater.json          app -> CLI   { pid, appVersion, state }
//   updater-request.json  CLI -> app   { action, requestedAt }
// The app consumes requests at boot and via an fs watch, so the flow
// is: read state -> (launch the app hidden if needed) -> request a
// check -> follow updater.json until it settles -> request the install
// and wait for the app to come back under a new pid. macOS-only, like
// the updater itself. The dev CLI refuses -- dev builds run from a
// checkout and have no update channel.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Mirrors UpdaterState (shared/schemas/runtime.ts), flattened: kind
// tags which of the optional fields are meaningful.
type updaterState struct {
	Kind    string `json:"kind"`
	Version string `json:"version,omitempty"`
	Message string `json:"message,omitempty"`
}

type updaterStatus struct {
	Pid        int          `json:"pid"`
	AppVersion string       `json:"appVersion"`
	State      updaterState `json:"state"`
}

func updaterStatusPath() string { return filepath.Join(shigomoriRoot(), "updater.json") }
func updateRequestPath() string { return filepath.Join(shigomoriRoot(), "updater-request.json") }

// Stat before read: a write landing between the two syscalls then
// yields content newer than the mtime, which at worst delays a verdict
// by one poll -- the reverse order could stamp a stale read as fresh
// and misreport "up to date" mid-check.
func readUpdaterStatus() (*updaterStatus, time.Time) {
	var modTime time.Time
	if info, err := os.Stat(updaterStatusPath()); err == nil {
		modTime = info.ModTime()
	}
	raw, err := os.ReadFile(updaterStatusPath())
	if err != nil {
		return nil, modTime
	}
	var status updaterStatus
	if json.Unmarshal(raw, &status) != nil || status.Pid <= 0 {
		return nil, modTime
	}
	return &status, modTime
}

// Liveness probe: signal 0 delivers nothing but still checks
// existence. EPERM means "exists, not ours".
func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// A live pid alone isn't "the app is running" -- pids recycle across
// reboots, and trusting a recycled one would skip the launch and leave
// the CLI talking to nobody. The executable name (CFBundleExecutable)
// survives bundle moves and renames, so require it to match too.
func appProcessAlive(pid int) bool {
	if !pidAlive(pid) {
		return false
	}
	comm, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && strings.Contains(string(comm), appExecutableName)
}

func writeUpdateRequest(action string) error {
	return atomicWriteJSON(updateRequestPath(), map[string]any{
		"action":      action,
		"requestedAt": time.Now().UnixMilli(),
	})
}

const (
	appLaunchTimeout = 20 * time.Second
	checkTimeout     = 90 * time.Second
	// A slow connection can hold "downloading" for a while, so the
	// check deadline stretches to this once a download is observed.
	downloadTimeout = 10 * time.Minute
	restartTimeout  = 2 * time.Minute
	pollInterval    = 200 * time.Millisecond
)

func cmdUpdate(_ cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{bools: map[string][]string{"check": {}}})
	if err != nil {
		return exitCodeOf(err), err
	}
	if len(parsed.positionals) > 0 {
		return 2, usageErrf("update takes no arguments (flags: --check).")
	}
	if runtime.GOOS != "darwin" {
		return 1, errf("Updating the app is only supported on macOS.")
	}
	if flavor != "prod" {
		return 1, errf("This is the dev CLI. Dev builds have no update channel. Pull the checkout instead.")
	}
	checkOnly := parsed.bools["check"]

	spin := newSpinner()
	defer spin.stop()

	// Baseline for waitForOutcome's mtime heuristic: any updater.json
	// write after this instant is post-sample activity, whether it came
	// from our request, the launched app's boot check, or an in-flight
	// check we happened to sample mid-run.
	since := time.Now()
	status, _ := readUpdaterStatus()
	launchedApp := false
	if status == nil || !appProcessAlive(status.Pid) {
		// Background launch: an update check shouldn't yank focus away
		// from the terminal.
		spin.set("starting Shigoto no Mori")
		if err := openAppBundle(true); err != nil {
			return 1, err
		}
		launchedApp = true
		if status, err = waitForApp(); err != nil {
			return 1, err
		}
	}
	installedVersion, appPid := status.AppVersion, status.Pid

	state := status.State
	if state.Kind == "unsupported" {
		return 1, errf("This app build has no update channel.")
	}
	// Anything but a staged update warrants a fresh check. The request
	// is safe to send unconditionally: the app no-ops when a check or
	// download is already in flight, and the outcome is followed the
	// same way either way.
	if state.Kind != "ready" {
		if err := writeUpdateRequest("check"); err != nil {
			return 1, errf("Couldn't write the update request: %v", err)
		}
		if state, err = waitForOutcome(spin, since); err != nil {
			return 1, err
		}
	}

	switch state.Kind {
	case "error":
		return 1, errf("Update check failed: %s", state.Message)
	case "idle":
		spin.stop()
		if jsonMode {
			emit(map[string]any{"ok": true, "status": "up-to-date", "version": installedVersion})
		} else {
			out("already up to date " + dimOut("("+installedVersion+")"))
			noteAppLaunched(launchedApp)
		}
		return 0, nil
	case "ready":
	default:
		return 1, errf("Unexpected updater state %q.", state.Kind)
	}

	if checkOnly {
		spin.stop()
		if jsonMode {
			emit(map[string]any{
				"ok": true, "status": "update-ready",
				"version": state.Version, "installed": installedVersion,
			})
		} else {
			out(greenOut("update ready: ") + cyanOut(state.Version) +
				dimOut(" (installed "+installedVersion+")"))
			note(dimErr("Run `" + binaryName + " update` to install."))
			noteAppLaunched(launchedApp)
		}
		return 0, nil
	}

	if err := writeUpdateRequest("install"); err != nil {
		return 1, errf("Couldn't write the update request: %v", err)
	}
	spin.set("restarting Shigoto no Mori to install " + state.Version)
	newStatus, err := waitForRestart(spin, appPid, installedVersion)
	if err != nil {
		return 1, err
	}
	spin.stop()
	if jsonMode {
		emit(map[string]any{
			"ok": true, "status": "updated",
			"from": installedVersion, "to": newStatus.AppVersion,
		})
	} else {
		out("updated " + cyanOut(installedVersion) + dimOut(" -> ") +
			boldOut(greenOut(newStatus.AppVersion)))
	}
	return 0, nil
}

// The app is reachable once updater.json carries a live pid. A stale
// file from a previous run may sit there while the fresh instance
// boots, but requests are consumed at bridge start either way, so an
// early return with slightly stale state only costs one extra check.
func waitForApp() (*updaterStatus, error) {
	deadline := time.Now().Add(appLaunchTimeout)
	for {
		if status, _ := readUpdaterStatus(); status != nil && appProcessAlive(status.Pid) {
			return status, nil
		}
		if time.Now().After(deadline) {
			return nil, errf("The app started but never published updater state. " +
				"Try updating from the app: Settings -> General.")
		}
		time.Sleep(pollInterval)
	}
}

// Follow updater.json until the check settles: ready, or a
// fresh-enough idle (up to date) / error. Idle and error are only
// trusted once the state file was written after `since` -- the app
// always writes "checking" before a verdict, so any post-`since` write
// of either means a whole check ran, whether or not the intermediate
// states landed between two polls. An older one is last run's result
// still sitting there (a leftover error must not be reported as the
// outcome of the check we just requested). Ready needs no guard: a
// staged update stays actionable regardless of when it was found.
func waitForOutcome(spin *spinner, since time.Time) (updaterState, error) {
	spin.set("checking for updates")
	deadline := time.Now().Add(checkTimeout)
	downloadSeen := false
	for {
		if status, modTime := readUpdaterStatus(); status != nil {
			switch status.State.Kind {
			case "downloading":
				if !downloadSeen {
					downloadSeen = true
					deadline = time.Now().Add(downloadTimeout)
				}
				spin.set("downloading update")
			case "ready":
				return status.State, nil
			case "idle", "error":
				if modTime.After(since) {
					return status.State, nil
				}
			}
		}
		if time.Now().After(deadline) {
			return updaterState{}, errf("Timed out waiting for the app's updater. " +
				"Try updating from the app: Settings -> General.")
		}
		time.Sleep(pollInterval)
	}
}

// The install restarts the app. Success is updater.json reappearing
// under a new pid AND a new version -- a failed Squirrel swap
// relaunches the old bundle under a new pid, which must not be
// reported as "updated X -> X". If the app is busy (running scripts),
// it asks for confirmation in a dialog the CLI can't see -- hence the
// hint -- and a decline simply times out here with the old pid still
// alive. The timeout message stays tentative because a late
// confirmation still installs after the CLI has given up.
func waitForRestart(spin *spinner, oldPid int, oldVersion string) (*updaterStatus, error) {
	start := time.Now()
	deadline := start.Add(restartTimeout)
	hinted := false
	sameVersion := false
	for {
		status, _ := readUpdaterStatus()
		if status != nil && status.Pid != oldPid && appProcessAlive(status.Pid) {
			if status.AppVersion != oldVersion {
				return status, nil
			}
			sameVersion = true
		}
		if status != nil && status.Pid == oldPid && status.State.Kind == "error" {
			return nil, errf("Install failed: %s", status.State.Message)
		}
		if !hinted && time.Since(start) > 15*time.Second {
			hinted = true
			spin.set("waiting for the app to restart " + dimErr("(confirm in the app if it's asking)"))
		}
		if time.Now().After(deadline) {
			if sameVersion {
				return nil, errf("The app restarted but is still on %s -- the install "+
					"may have failed. Check the app.", oldVersion)
			}
			return nil, errf("The app hasn't restarted yet -- it may still be waiting on a " +
				"confirmation in the app (confirming there will still install the update), " +
				"or the install failed. Check the app.")
		}
		time.Sleep(pollInterval)
	}
}

// Stderr postscript for read-only outcomes that had to boot the app:
// leaving a full app running is worth a mention when the user only
// asked a question.
func noteAppLaunched(launched bool) {
	if launched {
		note(dimErr("Started Shigoto no Mori to run the check. It's still running."))
	}
}

// --- progress spinner (stderr) ---

// Animated on an interactive terminal. Elsewhere it degrades to one
// stderr note per label change (and stays silent in --json, where the
// final document is the whole story). The stdout result line never
// goes through here.
type spinner struct {
	mu       sync.Mutex
	label    string
	animated bool
	stopCh   chan struct{}
	wg       sync.WaitGroup
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func newSpinner() *spinner {
	s := &spinner{}
	// Animation follows output.go's escape-capability gate: stderrColor
	// is exactly "stderr is a terminal that can take escapes, and this
	// isn't --json / NO_COLOR / TERM=dumb".
	if !stderrColor {
		return s
	}
	s.animated = true
	s.stopCh = make(chan struct{})
	s.wg.Add(1)
	go s.loop()
	return s
}

func (s *spinner) loop() {
	defer s.wg.Done()
	ticker := time.NewTicker(80 * time.Millisecond)
	defer ticker.Stop()
	frame := 0
	for {
		select {
		case <-s.stopCh:
			fmt.Fprint(os.Stderr, "\r\x1b[2K")
			return
		case <-ticker.C:
			s.mu.Lock()
			label := s.label
			s.mu.Unlock()
			fmt.Fprint(os.Stderr, "\r\x1b[2K"+cyanErr(spinnerFrames[frame%len(spinnerFrames)])+" "+label)
			frame++
		}
	}
}

func (s *spinner) set(label string) {
	s.mu.Lock()
	changed := label != s.label
	s.label = label
	s.mu.Unlock()
	// Not animated: one note per label change. Labels are plain text
	// here -- the *Err painters no-op whenever stderrColor is off.
	if !s.animated && changed && !jsonMode {
		note(label)
	}
}

// Idempotent: cmdUpdate defers a stop and also stops before printing
// results, so the success path clears the line before stdout writes.
func (s *spinner) stop() {
	if !s.animated {
		return
	}
	s.animated = false
	close(s.stopCh)
	s.wg.Wait()
}
