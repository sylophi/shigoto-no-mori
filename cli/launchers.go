package main

// The app's launcher row, ported for `sm open`: detected macOS apps,
// custom launcher commands from global and project config, and the
// GitHub web entry. The tool catalog is one embedded JSON file shared
// with main/lib/launchers/index.ts. Ordering and the rolling 14-day
// use log are shared with the app through state.json's launcherUseLog
// key, so launching from the terminal reorders the row in the app and
// vice versa.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

type launcherApp struct {
	id          string
	label       string
	bundleNames []string
	cli         string
}

const t3codeID = "t3code"

// The tool catalog is embedded from embed/launcher-catalog.json, which
// main/lib/launchers/index.ts imports too -- one list, two consumers.
// bundleNames resolve against appRoots; "__finder__" is the
// always-available Finder sentinel.
//
//go:embed embed/launcher-catalog.json
var launcherCatalogJSON []byte

var launcherCatalog = func() []launcherApp {
	var entries []struct {
		ID          string   `json:"id"`
		Label       string   `json:"label"`
		BundleNames []string `json:"bundleNames"`
		CLI         string   `json:"cli"`
	}
	if err := json.Unmarshal(launcherCatalogJSON, &entries); err != nil {
		panic("embedded launcher-catalog.json is invalid: " + err.Error())
	}
	catalog := make([]launcherApp, len(entries))
	for i, e := range entries {
		catalog[i] = launcherApp{id: e.ID, label: e.Label, bundleNames: e.BundleNames, cli: e.CLI}
	}
	return catalog
}()

func appRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return []string{"/Applications", filepath.Join(home, "Applications"), "/System/Applications"}
}

func bundlePathFor(bundleName string) string {
	for _, root := range appRoots() {
		candidate := filepath.Join(root, bundleName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func launcherAvailable(a launcherApp) bool {
	for _, name := range a.bundleNames {
		if name == "__finder__" || bundlePathFor(name) != "" {
			return true
		}
	}
	if a.cli != "" {
		if _, err := exec.LookPath(a.cli); err == nil {
			return true
		}
	}
	return false
}

// One row of the merged launcher list. Exactly one of app/custom/webURL
// is set, mirroring the app's app:/custom:/web: id prefixes.
type launcherEntry struct {
	id     string
	label  string
	app    *launcherApp
	custom *launcherCommand
	webURL string
}

var githubRemoteRe = regexp.MustCompile(`^(?:git@|ssh://git@|https://)([^:/]*github[^:/]*)[:/]([^/]+)/(.+?)(?:\.git)?/?$`)

func githubWebURL(projectPath string) string {
	raw, err := runGit(projectPath, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	m := githubRemoteRe.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return ""
	}
	return "https://" + m[1] + "/" + m[2] + "/" + m[3]
}

// The full resolvable list in the app's order of assembly: detected
// tools, the GitHub web entry, then custom commands (global before
// project). Hidden filtering and use-count ordering are the caller's
// concern, same split as the app.
func availableLaunchers(proj project) []launcherEntry {
	var entries []launcherEntry
	for i := range launcherCatalog {
		a := &launcherCatalog[i]
		if launcherAvailable(*a) {
			entries = append(entries, launcherEntry{id: "app:" + a.id, label: a.label, app: a})
		}
	}
	if webURL := githubWebURL(proj.Path); webURL != "" {
		entries = append(entries, launcherEntry{id: "web:github", label: "GitHub", webURL: webURL})
	}
	appendCustom := func(commands []launcherCommand) {
		for i := range commands {
			c := &commands[i]
			entries = append(entries, launcherEntry{id: "custom:" + c.ID, label: c.Label, custom: c})
		}
	}
	appendCustom(readGlobalConfigHints().Launchers)
	if config := readProjectConfig(proj.ID); config != nil {
		appendCustom(config.Launchers)
	}
	return entries
}

const useLogWindow = 14 * 24 * time.Hour

// Sorts by rolling-window use (descending), label as tiebreaker --
// the launcher row's ordering, driven by the same state.json log.
func sortLaunchersByUse(entries []launcherEntry) {
	var log map[string][]int64
	if raw, ok := readStateHints()["launcherUseLog"]; ok {
		_ = json.Unmarshal(raw, &log)
	}
	cutoff := time.Now().Add(-useLogWindow).UnixMilli()
	count := func(id string) int {
		n := 0
		for _, t := range log[id] {
			if t >= cutoff {
				n++
			}
		}
		return n
	}
	sort.SliceStable(entries, func(a, b int) bool {
		if diff := count(entries[a].id) - count(entries[b].id); diff != 0 {
			return diff > 0
		}
		return strings.ToLower(entries[a].label) < strings.ToLower(entries[b].label)
	})
}

// One rolling-window bump step, shared by every use log: launchers
// here, package scripts in cmd_run.go. Ports pruneAndPush from
// main/lib/util/useLog.ts: drop timestamps older than the window,
// append now.
func pruneAndAppendUse(times []int64) []int64 {
	now := time.Now().UnixMilli()
	cutoff := now - useLogWindow.Milliseconds()
	fresh := []int64{}
	for _, t := range times {
		if t >= cutoff {
			fresh = append(fresh, t)
		}
	}
	return append(fresh, now)
}

func bumpLauncherUse(id string) {
	err := updateStateKey("launcherUseLog", func(raw json.RawMessage) (any, error) {
		log := map[string][]int64{}
		if raw != nil {
			if err := json.Unmarshal(raw, &log); err != nil {
				return nil, malformedKeyErr(statePath(), "launcherUseLog", err)
			}
		}
		log[id] = pruneAndAppendUse(log[id])
		return log, nil
	})
	if err != nil {
		vlog("[open] use log bump failed: %v", err)
		noteStateTrouble(err)
	}
}

func launchEntry(entry launcherEntry, worktreePath string) error {
	switch {
	case entry.webURL != "":
		return exec.Command("open", entry.webURL).Run()
	case entry.custom != nil:
		return launchCustomCommand(entry.custom.Command, worktreePath)
	case entry.app != nil:
		return launchDetectedApp(*entry.app, worktreePath)
	}
	return errf("Launcher %q has nothing to launch.", entry.label)
}

// Fire-and-forget through the user's shell, detached so it outlives
// this process -- the app's launchCustom.
func launchCustomCommand(command, worktreePath string) error {
	cmd := exec.Command("/bin/sh", "-c", command)
	cmd.Dir = worktreePath
	cmd.Env = append(os.Environ(), "SHIGOMORI_WORKSPACE_PATH="+worktreePath)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Protocol deep links for apps whose only "open this folder" API is
// their URL scheme (see deepLinkFor in main/lib/launchers/index.ts).
func deepLinkFor(appID, worktreePath string) string {
	switch appID {
	case "codex":
		return "codex://threads/new?path=" + url.QueryEscape(worktreePath)
	case "claude":
		return "claude://code/new?folder=" + url.QueryEscape(worktreePath)
	}
	return ""
}

func launchDetectedApp(a launcherApp, worktreePath string) error {
	if deepLink := deepLinkFor(a.id, worktreePath); deepLink != "" {
		return exec.Command("open", deepLink).Run()
	}
	if a.id == t3codeID {
		return launchT3Code(a, worktreePath)
	}
	// CLI shim first so in-app window preferences are honored; bundle
	// fallback via Launch Services.
	if a.cli != "" {
		if _, err := exec.LookPath(a.cli); err == nil {
			if exec.Command(a.cli, worktreePath).Run() == nil {
				return nil
			}
		}
	}
	for _, name := range a.bundleNames {
		if name == "__finder__" {
			return exec.Command("open", worktreePath).Run()
		}
		if bundle := bundlePathFor(name); bundle != "" {
			appName := strings.TrimSuffix(filepath.Base(bundle), ".app")
			return exec.Command("open", "-a", appName, worktreePath).Run()
		}
	}
	return errf("No installed app found for %s.", a.label)
}

// T3 Code can't be handed a folder; register the worktree through the
// CLI bundled inside the app, then activate it (see the app's
// t3code.ts for the full story).
func launchT3Code(a launcherApp, worktreePath string) error {
	bundle := ""
	for _, name := range a.bundleNames {
		if bundle = bundlePathFor(name); bundle != "" {
			break
		}
	}
	if bundle == "" {
		return errf("No installed app found for %s.", a.label)
	}
	appName := strings.TrimSuffix(filepath.Base(bundle), ".app")
	binary := filepath.Join(bundle, "Contents", "MacOS", appName)
	script := filepath.Join(bundle, "Contents", "Resources", "app.asar", "apps", "server", "dist", "bin.mjs")
	cmd := exec.Command(binary, script, "project", "add", worktreePath)
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	if combined, err := cmd.CombinedOutput(); err != nil &&
		!strings.Contains(string(combined), "ProjectAlreadyExistsError") {
		return fmt.Errorf("t3 project add: %w", err)
	}
	return exec.Command("open", "-a", bundle).Run()
}
