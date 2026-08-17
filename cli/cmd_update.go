package main

// sm update -- update the app (and with it this CLI, a symlink into
// the bundle) from the terminal. The CLI owns the whole pipeline
// (updater.go): it queries the release feed, downloads and verifies
// the new bundle, and swaps /Applications itself. The app is only
// involved when it's already running -- a bundle swap under a live
// instance would leave it executing a deleted version -- and even then
// it is never launched: the CLI stages the update, asks the running
// app to restart over the on-disk bridge (updaterBridge.ts), and the
// app confirms with the user if it's busy, spawns a detached
// `sm update --finish-install`, and quits. That installer waits for
// the pid to exit, swaps, and relaunches.
//
// Modes:
//   (default)         check + stage, then install (directly, or via
//                     the running app's restart handoff).
//   --check           query the feed and report. Touches nothing.
//   --stage           check + download + verify into updates/staged,
//                     no install. The app's own periodic check runs
//                     this, so Settings and the CLI share one pipeline.
//   --finish-install --pid <n>
//                     internal: spawned detached by the app right
//                     before it quits. Waits for <n> to exit, swaps
//                     the staged bundle in, relaunches the app.
//
// macOS-only, and the dev CLI refuses -- dev builds run from a
// checkout and have no update channel.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The subset of UpdaterStatus (shared/schemas/runtime.ts) the CLI
// reads: pid/appVersion to tell whether a live instance has to be
// restarted around the swap, and the state's error kind so an
// app-side install failure surfaces immediately (waitForRestart)
// instead of as a timeout.
type updaterStatus struct {
	Pid        int    `json:"pid"`
	AppVersion string `json:"appVersion"`
	State      struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"state"`
}

func updaterStatusPath() string { return filepath.Join(shigomoriRoot(), "updater.json") }
func updateRequestPath() string { return filepath.Join(shigomoriRoot(), "updater-request.json") }

// nil when the file is absent or malformed -- every caller treats
// those the same way ("no reachable app").
func readUpdaterStatus() *updaterStatus {
	raw, err := os.ReadFile(updaterStatusPath())
	if err != nil {
		return nil
	}
	var status updaterStatus
	if json.Unmarshal(raw, &status) != nil || status.Pid <= 0 {
		return nil
	}
	return &status
}

// Liveness probe: signal 0 delivers nothing but still checks
// existence. EPERM means "exists, not ours".
func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// A live pid alone isn't "the app is running" -- pids recycle across
// reboots, and trusting a recycled one would hand the install off to a
// process that will never restart. The executable name
// (CFBundleExecutable) survives bundle moves and renames, so require
// it to match too.
func appProcessAlive(pid int) bool {
	if !pidAlive(pid) {
		return false
	}
	comm, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && strings.Contains(string(comm), appExecutableName)
}

// True when any process carries the app's executable name, even one
// that hasn't published updater.json yet: a freshly launched instance
// publishes only once its updater starts, and during that window the
// file still holds the previous run's dead pid. -x is an exact match,
// so the "... Helper" renderer processes don't count.
func appProcessRunning() bool {
	return exec.Command("pgrep", "-x", appExecutableName).Run() == nil
}

// The running app instance, when there is one.
func runningApp() *updaterStatus {
	status := readUpdaterStatus()
	if status == nil || !appProcessAlive(status.Pid) {
		return nil
	}
	return status
}

func writeUpdateRequest(action string) error {
	return atomicWriteJSON(updateRequestPath(), map[string]any{
		"action":      action,
		"requestedAt": time.Now().UnixMilli(),
	})
}

const (
	restartTimeout = 2 * time.Minute
	// How long a running-but-unpublished app gets to write updater.json
	// before the CLI gives up (it never swaps under a live instance).
	appPublishTimeout = 20 * time.Second
	pollInterval      = 200 * time.Millisecond
)

// NDJSON phase events for --json consumers, pinned by
// UpdateStageEventSchema (shared/schemas/runtime.ts) -- the app's
// check parses these as they stream. A no-op for humans, whose
// progress is the spinner.
func emitEvent(name string) {
	if jsonMode {
		emit(map[string]any{"event": name})
	}
}

func cmdUpdate(_ cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		bools:   map[string][]string{"check": {}, "stage": {}, "finish-install": {}},
		strings: map[string][]string{"pid": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if len(parsed.positionals) > 0 {
		return 2, usageErrf("update takes no arguments (flags: --check).")
	}
	if flavor != "prod" {
		return 1, errf("This is the dev CLI. Dev builds have no update channel. Pull the checkout instead.")
	}

	switch {
	case parsed.bools["finish-install"]:
		return cmdUpdateFinishInstall(parsed.strings["pid"])
	case parsed.bools["check"]:
		return cmdUpdateCheck()
	case parsed.bools["stage"]:
		return cmdUpdateStage()
	default:
		return cmdUpdateInstall()
	}
}

// --check: one feed request, no download, nothing touched on disk.
func cmdUpdateCheck() (int, error) {
	spin := newSpinner()
	spin.set("checking for updates")
	release, err := queryFeed()
	spin.stop()
	if err != nil {
		return 1, err
	}
	if release == nil {
		reportUpToDate()
		return 0, nil
	}
	if jsonMode {
		emit(map[string]any{
			"ok": true, "status": "update-available",
			"version": release.Version, "installed": version,
		})
	} else {
		out(greenOut("update available: ") + cyanOut(release.Version) +
			dimOut(" (installed "+version+")"))
		note(dimErr("Run `" + binaryName + " update` to install."))
	}
	return 0, nil
}

// The shared front half of --stage and the full update: resolve the
// bundle and run the staging pipeline (which sweeps earlier runs'
// debris under its lock) with progress wired to the spinner and the
// --json event stream. A nil manifest with a nil error means already
// up to date.
func stageForCommand(spin *spinner) (*stagedManifest, string, error) {
	bundle, err := installedBundlePath()
	if err != nil {
		return nil, "", err
	}
	spin.set("checking for updates")
	man, err := stageUpdate(bundle, func(phase, newVersion string) {
		spin.set(phase + " " + newVersion)
		emitEvent(phase)
	})
	return man, bundle, err
}

func reportUpToDate() {
	if jsonMode {
		emit(map[string]any{"ok": true, "status": "up-to-date", "version": version})
	} else {
		out("already up to date " + dimOut("("+version+")"))
	}
}

// --stage: check + download + verify, stop short of installing. The
// app's periodic check shells out to this with --json and mirrors the
// event stream into its Settings state machine. The result document is
// pinned by UpdateStageResultSchema (shared/schemas/runtime.ts).
func cmdUpdateStage() (int, error) {
	spin := newSpinner()
	defer spin.stop()
	man, _, err := stageForCommand(spin)
	if err != nil {
		return exitCodeOf(err), err
	}
	spin.stop()
	if man == nil {
		reportUpToDate()
		return 0, nil
	}
	if jsonMode {
		doc := map[string]any{
			"ok": true, "status": "staged",
			"version": man.Version, "installed": version,
		}
		if man.Notes != "" {
			doc["notes"] = man.Notes
		}
		if man.ReleaseDate != "" {
			doc["releaseDate"] = man.ReleaseDate
		}
		emit(doc)
	} else {
		out(greenOut("update staged: ") + cyanOut(man.Version) +
			dimOut(" (installed "+version+")"))
		note(dimErr("Run `" + binaryName + " update` to install."))
	}
	return 0, nil
}

// The full ride: stage, then install. With no app running the CLI
// swaps the bundle itself and never launches anything. With a live app
// the install is handed to it so the restart (and the "scripts are
// running" confirmation) happens where the user can see it.
func cmdUpdateInstall() (int, error) {
	spin := newSpinner()
	defer spin.stop()
	man, bundle, err := stageForCommand(spin)
	if err != nil {
		return exitCodeOf(err), err
	}
	if man == nil {
		spin.stop()
		reportUpToDate()
		return 0, nil
	}

	app := runningApp()
	if app == nil && appProcessRunning() {
		// A live instance that hasn't published its state yet (fresh
		// launch, updater.json still naming a previous run's pid).
		// Swapping now would leave it running a deleted bundle, so
		// wait for it to publish rather than treating it as absent.
		spin.set("waiting for the running app")
		deadline := time.Now().Add(appPublishTimeout)
		for app == nil && time.Now().Before(deadline) {
			time.Sleep(pollInterval)
			app = runningApp()
		}
		if app == nil {
			return 1, errf("The app is running but hasn't published its updater state. "+
				"Wait for it to finish starting (or quit it) and rerun `%s update`.", binaryName)
		}
	}
	if app == nil {
		spin.set("installing " + man.Version)
		if err := installStaged(man, bundle); err != nil {
			return 1, err
		}
		spin.stop()
		reportUpdated(version, man.Version)
		return 0, nil
	}

	// Hand off to the running instance: it confirms (if busy), spawns
	// the detached installer, and quits. The relaunched app publishes a
	// fresh updater.json, which is our success signal.
	requestedAt := time.Now()
	if err := writeUpdateRequest("install"); err != nil {
		return 1, errf("Couldn't write the update request: %v", err)
	}
	spin.set("restarting Shigoto no Mori to install " + man.Version)
	newStatus, err := waitForRestart(spin, app.Pid, app.AppVersion, requestedAt)
	if err != nil {
		return 1, err
	}
	spin.stop()
	reportUpdated(app.AppVersion, newStatus.AppVersion)
	return 0, nil
}

func reportUpdated(from, to string) {
	if jsonMode {
		emit(map[string]any{"ok": true, "status": "updated", "from": from, "to": to})
	} else {
		out("updated " + cyanOut(from) + dimOut(" -> ") + boldOut(greenOut(to)))
	}
}

// --finish-install: the detached installer the app spawns just before
// quitting. Headless -- outcomes go to updates/install.log, and the
// relaunched app (or its absence) is what the user sees.
func cmdUpdateFinishInstall(pidArg string) (int, error) {
	pid, err := strconv.Atoi(strings.TrimSpace(pidArg))
	if err != nil || pid <= 0 {
		return 2, usageErrf("--finish-install requires --pid <app pid>.")
	}
	bundle, bundleErr := installedBundlePath()
	if bundleErr != nil {
		appendInstallLog("finish-install: %v", bundleErr)
		return 1, bundleErr
	}
	man := readStagedManifest()
	if man == nil {
		appendInstallLog("finish-install: no staged update to install")
		return 1, errf("No staged update to install.")
	}
	appendInstallLog("finish-install: waiting for app pid %d to exit (installing %s)", pid, man.Version)
	if err := waitForPidExit(pid); err != nil {
		appendInstallLog("finish-install: %v (aborting)", err)
		return 1, err
	}
	if err := installStaged(man, bundle); err != nil {
		appendInstallLog("finish-install: %v", err)
		return 1, err
	}
	// Relaunch by path, foreground: the user asked the app to restart.
	// (`open -b` could still resolve a stale LaunchServices entry for
	// the just-deleted aside bundle.)
	if err := exec.Command("open", bundle).Run(); err != nil {
		appendInstallLog("finish-install: installed %s but relaunch failed: %v", man.Version, err)
		return 1, errf("Installed %s but couldn't relaunch the app: %v", man.Version, err)
	}
	appendInstallLog("finish-install: installed %s and relaunched", man.Version)
	return 0, nil
}

// The handed-off install restarts the app. Success is updater.json
// reappearing under a new pid AND a new version -- a failed swap
// relaunching the old bundle must not be reported as "updated X -> X".
// An error the old pid publishes after our request (its installer
// spawn failed) is reported immediately with its message. The mtime
// guard keeps a leftover error from an earlier failed check -- which
// the app never clears on this path -- from being blamed on this
// install. If the app is busy (running scripts), it asks for
// confirmation in a dialog the CLI can't see -- hence the hint -- and
// a decline simply times out here with the old pid still alive. The
// timeout message stays tentative because a late confirmation still
// installs after the CLI has given up: the staged update survives
// until it's consumed.
func waitForRestart(spin *spinner, oldPid int, oldVersion string, requestedAt time.Time) (*updaterStatus, error) {
	start := time.Now()
	deadline := start.Add(restartTimeout)
	hinted := false
	sameVersion := false
	for {
		status := readUpdaterStatus()
		if status != nil && status.Pid != oldPid && appProcessAlive(status.Pid) {
			if status.AppVersion != oldVersion {
				return status, nil
			}
			sameVersion = true
		}
		if status != nil && status.Pid == oldPid && status.State.Kind == "error" {
			if info, err := os.Stat(updaterStatusPath()); err == nil && info.ModTime().After(requestedAt) {
				return nil, errf("Install failed: %s", status.State.Message)
			}
		}
		if !hinted && time.Since(start) > 15*time.Second {
			hinted = true
			spin.set("waiting for the app to restart " + dimErr("(confirm in the app if it's asking)"))
		}
		if time.Now().After(deadline) {
			if sameVersion {
				return nil, errf("The app restarted but is still on %s -- the install "+
					"may have failed. Check %s.", oldVersion, filepath.Join(updatesDir(), "install.log"))
			}
			return nil, errf("The app hasn't restarted yet -- it may still be waiting on a " +
				"confirmation in the app (confirming there will still install the update), " +
				"or the install failed. Check the app.")
		}
		time.Sleep(pollInterval)
	}
}

// --- progress spinner (stderr) ---

// Animated on an interactive terminal. Elsewhere it degrades to one
// stderr note per label change (and stays silent in --json, where the
// event stream is the whole story). The stdout result line never goes
// through here.
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

// Idempotent: commands defer a stop and also stop before printing
// results, so the success path clears the line before stdout writes.
func (s *spinner) stop() {
	if !s.animated {
		return
	}
	s.animated = false
	close(s.stopCh)
	s.wg.Wait()
}
