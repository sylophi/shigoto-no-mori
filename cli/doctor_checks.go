package main

// The individual `sm doctor` checks (the command, its rendering, and
// the --fix driver live in cmd_doctor.go). Every function here is
// read-only: a check either records a finding or attaches a repair
// closure the driver may run later, but never touches disk itself.
// Order within each group is the printed order.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// --- checks ---

// complete is false when the registry or the terrier listing couldn't
// be read, so projects is short of what is really registered.
func runDoctorChecks(projects []project, complete bool) *doctorReport {
	report := &doctorReport{}
	checkEnvironment(report)
	haveDataDir := checkDataDirGroup(report, projects, complete)
	checkOrphanTunnel(report)
	checkOrphanScripts(report)
	checkProjects(report, projects)
	// After the parallel project pass has listed every project's
	// worktrees (listWorktreeIdentities memoizes), so this spawns nothing.
	// Its line is sorted back under the data dir below.
	if haveDataDir {
		checkWorktreeBookkeeping(report, projects, complete)
	}
	// Group order, stable within a group, so the JSON reads in the order
	// the checklist prints whatever order the checks ran in.
	slices.SortStableFunc(report.findings, func(a, b finding) int {
		return slices.Index(groupOrder, a.Group) - slices.Index(groupOrder, b.Group)
	})
	return report
}

// --- environment ---

func checkEnvironment(report *doctorReport) {
	checkGit(report)
	checkGh(report)
	checkFlavorAndApp(report)
	checkPathShadowing(report)
	checkShellHook(report)
}

// rev-parse --path-format=absolute (context.go's one-spawn locator)
// landed in git 2.31, which makes it the real floor.
const minGitMajor, minGitMinor = 2, 31

func checkGit(report *doctorReport) {
	stdout, err := runGit("", "--version")
	if err != nil {
		report.fail(groupEnv, "git", "git", "not runnable (every command in sm shells out to it)",
			"Install git (`xcode-select --install`) and make sure it's on PATH.")
		return
	}
	raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(stdout), "git version "))
	major, minor, ok := parseGitVersion(raw)
	if ok && belowGitFloor(major, minor) {
		report.warn(groupEnv, "git", "git",
			raw+" is older than 2.31, which sm's repo detection needs",
			"Upgrade git (`brew upgrade git`).")
		return
	}
	report.ok(groupEnv, "git", "git", raw)
}

func checkGh(report *doctorReport) {
	if _, err := exec.LookPath("gh"); err != nil {
		report.warn(groupEnv, "gh", "gh",
			"not on PATH, so pr, merge, and land can't talk to GitHub without it",
			"Install the GitHub CLI (`brew install gh`), then `gh auth login`.")
		return
	}
	// Only success matters: `gh auth status` prints account details that
	// have no business in sm's output.
	if _, err := runGh("", "auth", "status"); err != nil {
		report.warn(groupEnv, "gh", "gh", "installed but not authenticated",
			"Run `gh auth login`.")
		return
	}
	report.ok(groupEnv, "gh", "gh", ghVersion()+", authenticated")
}

func ghVersion() string {
	stdout, err := runGh("", "--version")
	if err != nil {
		return "installed"
	}
	first, _, _ := strings.Cut(stdout, "\n")
	fields := strings.Fields(first)
	if len(fields) >= 3 && fields[0] == "gh" && fields[1] == "version" {
		return fields[2]
	}
	return strings.TrimSpace(first)
}

// The binary's own identity, and whether the app bundle behind it
// agrees. A prod CLI is a symlink into <bundle>/Contents/Resources, so
// a version mismatch means the sm on PATH is a stray copy that won't be
// carried along by `sm update`.
func checkFlavorAndApp(report *doctorReport) {
	if flavor != "prod" {
		report.ok(groupEnv, "app", "app",
			"dev build ("+binaryName+" "+version+"): runs from a checkout, no installed bundle")
		return
	}
	bundle, err := installedBundlePath()
	if err != nil {
		if found := findInstalledBundle(); found != "" {
			report.warn(groupEnv, "app", "app",
				"this binary isn't the one inside "+collapseHome(found)+", so `"+binaryName+" update` can't reach it",
				"Re-link the CLI from the app's Settings, or run "+collapseHome(filepath.Join(found, "Contents", "Resources", binaryName))+".")
			return
		}
		if aside := findAsideBundle(); aside != "" {
			report.fail(groupEnv, "app", "app",
				"the app is missing, but "+collapseHome(aside)+" is the copy an interrupted update set aside",
				"Rename it back to "+appExecutableName+".app.")
			return
		}
		report.warn(groupEnv, "app", "app",
			"no installed app bundle found, so update, app, and the port-pool toggle have nothing behind them",
			"Install Shigoto no Mori, or use the dev CLI (smd) against a checkout.")
		return
	}
	appVersion := bundleVersion(bundle)
	switch {
	case appVersion == "":
		report.warn(groupEnv, "app", "app",
			collapseHome(bundle)+" has no readable version in Info.plist",
			"Reinstall the app.")
	case appVersion != version:
		report.warn(groupEnv, "app", "app",
			"app is "+appVersion+" but this CLI is "+version+". They ship together, so one of them is stale",
			"Run `"+binaryName+" update`, or re-link the CLI from the app's Settings.")
	default:
		report.ok(groupEnv, "app", "app", appVersion+" at "+collapseHome(bundle))
	}
}

// The conventional install locations, for the case where the CLI on
// PATH is NOT the bundle's own copy (installedBundlePath refuses those
// on purpose. See updater.go). Goes through the launcher catalog's
// scan so there's one list of where an .app can live.
func findInstalledBundle() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	return bundlePathFor(appExecutableName + ".app")
}

// CFBundleShortVersionString, via `defaults`, because Info.plist is
// binary and reading it any other way would mean a plist parser. ""
// when it can't be read. Every caller treats that as "unknown", never
// as a mismatch.
func bundleVersion(bundle string) string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	stdout, err := exec.Command("defaults", "read",
		filepath.Join(bundle, "Contents", "Info"), "CFBundleShortVersionString").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(stdout))
}

// Two sm binaries on PATH is the quietest way for an install to go
// wrong: the one that answers `sm` and the one the app updates are
// different files, so fixes never seem to land.
func checkPathShadowing(report *doctorReport) {
	found := binariesOnPath(binaryName)
	switch len(found) {
	case 0:
		report.warn(groupEnv, "path", "PATH",
			"no `"+binaryName+"` on PATH, so this run came from an explicit path",
			"Link the CLI from the app's Settings, or add its directory to PATH.")
	case 1:
		report.ok(groupEnv, "path", "PATH", found[0])
	default:
		report.warn(groupEnv, "path", "PATH",
			fmt.Sprintf("%d different `%s` binaries on PATH; %s wins", len(found), binaryName, found[0]),
			"Remove the shadowed copies ("+strings.Join(found[1:], ", ")+") or reorder PATH.")
	}
}

// PATH order, deduped by the file each entry finally resolves to, so a
// symlink and its target don't read as a conflict.
func binariesOnPath(name string) []string {
	var found []string
	seen := map[string]bool{}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			dir = "."
		}
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		resolved := candidate
		if real, err := filepath.EvalSymlinks(candidate); err == nil {
			resolved = real
		}
		if seen[resolved] {
			continue
		}
		seen[resolved] = true
		found = append(found, collapseHome(candidate))
	}
	return found
}

// Installed AND current: install refreshes the block in place, so a
// block from an older vintage means the rc file was written by a
// version whose guard line has since changed.
func checkShellHook(report *doctorReport) {
	var installed, edited, stale []string
	for _, kind := range shellKinds {
		hook := inspectHook(kind)
		switch hook.state.State {
		case "installed":
			installed = append(installed, kind)
			if !hookBlockCurrent(kind, hook) {
				stale = append(stale, kind)
			}
		case "modified":
			edited = append(edited, kind)
		}
	}
	switch {
	case len(edited) > 0:
		report.warn(groupEnv, "shell-hook", "shell hook",
			"the block in "+strings.Join(edited, ", ")+"'s config was edited, so install and uninstall won't touch it",
			"Restore or remove the marker block, then `"+binaryName+" shell install`.")
	case len(stale) > 0:
		report.warn(groupEnv, "shell-hook", "shell hook",
			"the "+strings.Join(stale, ", ")+" hook is an older vintage than this build writes",
			"Run `"+binaryName+" shell install` to refresh it.")
	case len(installed) == 0:
		report.warn(groupEnv, "shell-hook", "shell hook",
			"not installed, so cd and create open a subshell instead of moving your shell",
			"Run `"+binaryName+" shell install`.")
	default:
		detail := "installed for " + strings.Join(installed, ", ")
		// "This session" is a terminal's. Without one (the app's --json
		// read) it would always read as a problem.
		if cdDirectiveFile() == "" && interactiveStdio() {
			detail += dimOut(" (not active in this session)")
		}
		report.ok(groupEnv, "shell-hook", "shell hook", detail)
	}
}

// Byte-compares an already-inspected hook against what install would
// write now. True (nothing to say) whenever there is no readable block.
func hookBlockCurrent(kind string, hook hookFile) bool {
	if kind == "fish" {
		data, err := os.ReadFile(hook.state.Path)
		return err != nil || string(data) == fishHookContent()
	}
	if !hook.found {
		return true
	}
	got := strings.Join(hook.lines[hook.span.begin:hook.span.end+1], "\n")
	return got == strings.TrimRight(hookBlock(kind), "\n")
}

// --- data dir ---

// False when there is no usable data dir, so nothing that reads it can
// mean anything.
func checkDataDirGroup(report *doctorReport, projects []project, complete bool) bool {
	if !checkDataDir(report) {
		return false
	}
	checkGlobalConfig(report)
	checkRegistryFile(report)
	checkStateFile(report)
	checkStaleLocks(report)
	checkStagingLock(report)
	checkUpdateLeftovers(report)
	checkPortAllocations(report)
	checkGlobalLaunchers(report)
	checkTerrier(report)
	checkDormantProjectState(report, projects, complete)
	return true
}

// access(2)'s W_OK. Go's syscall package doesn't name the mode bits,
// and a bare 0x2 at the call site says nothing.
const writeOK = 0x2

func checkDataDir(report *doctorReport) bool {
	root := dataDir()
	var source string
	switch cachedDataDirSource {
	case dataDirFromEnv:
		source = "from SHIGOMORI_DATA_DIR"
	case dataDirFromPointer:
		source = "from the pointer file"
	case dataDirLegacy:
		source = "pre-2.0 name"
	default:
		source = "default for the " + flavor + " flavor"
	}
	// A pointer that fails the guard is skipped without a word
	// (readDataDirPointer), which reads as every project vanishing.
	if cachedDataDirSource == dataDirDefault {
		if pointer := readPointerFile(); pointer.target != "" && pointer.problem != "" {
			report.warn(groupState, "data-dir", "data dir",
				"the pointer file names "+pointer.target+", which was ignored because "+pointer.problem+
					", so sm is using "+collapseHome(root)+" "+dimOut("("+source+")"),
				"Fix "+collapseHome(pointer.path)+" to name a data dir, or delete it.")
			// The rest of the data dir checks run on whatever sm is using.
			info, err := os.Stat(root)
			return err == nil && info.IsDir()
		}
	}
	info, err := os.Stat(root)
	switch {
	case os.IsNotExist(err):
		addProject := "`" + binaryName + " projects add`"
		fix := "Add a project (" + addProject + ") and it will be created."
		if cachedDataDirSource == dataDirFromPointer {
			pointer := collapseHome(readPointerFile().path)
			if volume := unmountedVolume(root); volume != "" {
				report.fail(groupState, "data-dir", "data dir",
					"the pointer file names "+root+", on "+volume+", which isn't connected",
					"Connect the drive. To start over on this Mac instead, delete "+pointer+".")
				return false
			}
			fix = "If the data was moved or deleted, fix or delete " + pointer +
				". Otherwise add a project (" + addProject + ") and it will be created."
		}
		report.warn(groupState, "data-dir", "data dir",
			collapseHome(root)+" doesn't exist yet ("+source+"), so nothing is registered", fix)
		return false
	case err != nil:
		report.fail(groupState, "data-dir", "data dir",
			collapseHome(root)+" can't be read: "+err.Error(),
			"Check the permissions on "+collapseHome(root)+".")
		return false
	case !info.IsDir():
		report.fail(groupState, "data-dir", "data dir",
			collapseHome(root)+" is a file, not a directory ("+source+")",
			"Move it aside, or point SHIGOMORI_DATA_DIR somewhere else.")
		return false
	}
	if syscall.Access(root, writeOK) != nil {
		report.fail(groupState, "data-dir", "data dir",
			collapseHome(root)+" isn't writable, so no command that changes state can work",
			"Fix its ownership or permissions.")
		return true
	}
	switch cachedDataDirSource {
	case dataDirLegacy:
		report.warn(groupState, "data-dir", "data dir",
			collapseHome(root)+" "+dimOut("("+source+")"),
			"Rename it to ~/"+dataDirName+" from the app's Settings > Data location.")
		return true
	case dataDirFromPointer:
		// A data-folder move copies, repoints, then deletes the old copy.
		// One that died after the repoint leaves the old tree behind,
		// complete and ignored.
		if reportIgnoredCopy(report, root, source, dataDirName,
			"If a data-folder move left it behind, delete it once you've checked nothing in it is newer.") {
			return true
		}
	case dataDirDefault:
		// Both names holding state means an upgrade seeded the current
		// one while the old one was unreachable: the old data is now
		// ignored, silently, unless someone says so.
		if reportIgnoredCopy(report, root, source, legacyDataDirName,
			"Move it aside, or merge what you need from it by hand.") {
			return true
		}
	}
	report.ok(groupState, "data-dir", "data dir", collapseHome(root)+" "+dimOut("("+source+")"))
	return true
}

// Warns when ~/<name>, a data dir sm isn't using, still holds state
// that is now silently ignored. Reports whether it did.
func reportIgnoredCopy(report *doctorReport, root, source, name, fix string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	other := filepath.Join(home, name)
	if other == root || sameDirectory(other, root) || holdsState(other) != statePresent {
		return false
	}
	report.warn(groupState, "data-dir", "data dir",
		collapseHome(root)+" "+dimOut("("+source+")")+"; "+collapseHome(other)+" also holds state and is ignored",
		fix)
	return true
}

// "/Volumes/<name>" when path lives on a volume that isn't mounted,
// else "". A missing data dir there is a disconnected drive, not a
// fresh install.
func unmountedVolume(path string) string {
	rest, ok := strings.CutPrefix(path, "/Volumes/")
	if !ok {
		return ""
	}
	name, _, _ := strings.Cut(rest, "/")
	volume := "/Volumes/" + name
	if _, err := os.Stat(volume); name == "" || err == nil {
		return ""
	}
	return volume
}

func checkGlobalConfig(report *doctorReport) {
	path := configJSONPath()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		report.ok(groupState, "config", configFile, "absent, so defaults apply")
		return
	}
	if err != nil {
		report.fail(groupState, "config", configFile, "unreadable: "+err.Error(),
			"Fix the permissions on "+collapseHome(path)+".")
		return
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		report.fail(groupState, "config", configFile,
			"isn't valid JSON, so every global preference is silently ignored",
			"Repair the JSON in "+collapseHome(path)+", or delete it to fall back to defaults.")
		return
	}
	var known globalConfig
	if json.Unmarshal(raw, &known) != nil {
		report.warn(groupState, "config", configFile,
			"parses, but a field has the wrong type and is being dropped",
			"Check "+collapseHome(path)+" against the app's Settings.")
		return
	}
	report.ok(groupState, "config", configFile, fmt.Sprintf("valid, %d key%s", len(probe), plural(len(probe))))
}

func checkRegistryFile(report *doctorReport) {
	// registry.json is the file that matters here: projects and shelf
	// flags moved out of state.json, which now holds only UI history.
	// ensureRegistrySplit runs first so a data dir still in the old shape is
	// drained and judged on what sm will actually read.
	if err := ensureRegistrySplit(); err != nil {
		report.fail(groupState, "registry", registryFile,
			"can't be split out of state.json: "+err.Error(),
			"Fix the permissions on "+collapseHome(dataDir())+".")
		return
	}
	path := registryPath()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		report.ok(groupState, "registry", registryFile, "absent, so no projects are registered yet")
		return
	}
	if err != nil {
		report.fail(groupState, "registry", registryFile, "unreadable: "+err.Error(),
			"Fix the permissions on "+collapseHome(path)+".")
		return
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(raw, &all) != nil {
		report.fail(groupState, "registry", registryFile,
			"isn't valid JSON, so every registered project is invisible to sm and the app",
			"Repair the JSON in "+collapseHome(path)+" (it holds the project registry).")
		return
	}
	var projects []project
	if entry, ok := all[projectsKey]; ok && json.Unmarshal(entry, &projects) != nil {
		report.fail(groupState, "registry", registryFile,
			"the projects list has the wrong shape, so no project resolves",
			"Repair the projects array in "+collapseHome(path)+".")
		return
	}
	var order []string
	if entry, ok := all[projectOrderKey]; ok && json.Unmarshal(entry, &order) != nil {
		report.warn(groupState, "registry", registryFile,
			"the projectOrder list has the wrong shape, so projects list in their default order and can't be reordered",
			"Repair or delete the projectOrder key in "+collapseHome(path)+".")
		return
	}
	malformed := 0
	for _, p := range projects {
		if p.ID == "" || p.Path == "" {
			malformed++
		}
	}
	if malformed > 0 {
		report.warn(groupState, "registry", registryFile,
			fmt.Sprintf("%d registry %s missing an id or path", malformed,
				pluralize(malformed, "entry is", "entries are")),
			"Remove the incomplete entries from "+collapseHome(path)+".")
		return
	}
	report.ok(groupState, "registry", registryFile,
		fmt.Sprintf("valid, %d project%s registered", len(projects), plural(len(projects))))
}

// state.json holds only UI history (use counts, view preferences), so
// a broken one never stops a command. But every write to it is refused
// until it is fixed (updateFileKey), and the only sign is a one-time
// note on some unrelated command's stderr.
func checkStateFile(report *doctorReport) {
	if _, err := readStateFile(); err != nil {
		report.warn(groupState, "state", stateFile,
			"can't be used ("+err.Error()+"), so use counts and view preferences are lost and nothing new is recorded",
			"Repair "+collapseHome(statePath())+", or delete it. It holds only that history.")
		return
	}
	if _, err := os.Stat(statePath()); os.IsNotExist(err) {
		return // absent until something is used; nothing to say
	}
	report.ok(groupState, "state", stateFile, "valid")
}

// Advisory locks (state.go's protocol) are created and unlinked around
// a read-modify-write measured in milliseconds. One that has sat there
// past lockStale belonged to a process that died holding it, and it
// costs every writer the full lock timeout until something breaks it.
func checkStaleLocks(report *doctorReport) {
	locks := findStaleLocks(dataDir())
	if len(locks) == 0 {
		report.ok(groupState, "locks", "locks", "no stale lock files")
		return
	}
	names := make([]string, len(locks))
	for i, lock := range locks {
		names[i] = collapseHome(lock)
	}
	label := fmt.Sprintf("%d stale lock file%s", len(locks), plural(len(locks)))
	detail := names[0] + " has been held for longer than a write can take"
	if extra := len(locks) - 1; extra > 0 {
		detail += fmt.Sprintf(" (and %d more)", extra)
	}
	report.repairable(groupState, "locks", "locks", statusWarn, detail,
		"Delete it. The process that took it is gone.",
		&repair{
			prompt:      "Delete " + label + " (" + strings.Join(names, ", ") + ")?",
			label:       "deleted " + label,
			destructive: true,
			apply: func() error {
				for _, lock := range locks {
					if err := os.Remove(lock); err != nil && !os.IsNotExist(err) {
						return err
					}
				}
				return nil
			},
		})
}

// Only the data dir's own tree is walked, and only where locks are
// ever taken: the data dir itself, the per-project dirs, and iconCache/
// (iconcache.go takes index.json.lock under the same protocol).
// updates/ holds downloads, never a lock.
func findStaleLocks(root string) []string {
	var stale []string
	scan := func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".lock") {
				continue
			}
			info, err := entry.Info()
			if err != nil || time.Since(info.ModTime()) <= lockStale {
				continue
			}
			stale = append(stale, filepath.Join(dir, entry.Name()))
		}
	}
	scan(root)
	scan(filepath.Join(root, "iconCache"))
	projectsDir := filepath.Join(root, "projects")
	if entries, err := os.ReadDir(projectsDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			scan(filepath.Join(projectsDir, entry.Name()))
			scan(filepath.Join(projectsDir, entry.Name(), "worktrees"))
		}
	}
	sort.Strings(stale)
	return stale
}

// The update stager's pidfile (updater.go) isn't time-based: it is held
// for a whole download, and a crashed stager is identified by its pid
// being dead.
func checkStagingLock(report *doctorReport) {
	path := stagingLockPath()
	present, pid, alive := stagingLockHolder()
	if !present {
		return // the normal case; no line for it
	}
	if alive {
		report.ok(groupState, "staging-lock", "update staging",
			fmt.Sprintf("in progress (pid %d)", pid))
		return
	}
	detail := "left behind by a crashed update"
	if pid != 0 {
		detail += fmt.Sprintf(" (pid %d is gone)", pid)
	}
	report.repairable(groupState, "staging-lock", "update staging", statusWarn,
		detail+", so `"+binaryName+" update` refuses to run",
		"Delete "+collapseHome(path)+".",
		&repair{
			prompt:      "Delete the stale update staging lock at " + collapseHome(path) + "?",
			label:       "deleted the stale update staging lock",
			destructive: true,
			apply:       func() error { return os.Remove(path) },
		})
}

// Everything sm keys by worktree id: the registry's marks (shelved,
// auto-pull, shelf snapshots) and each project's worktrees/<id>.json.
// sm rm clears them, so ids that match nothing mean worktrees were
// removed outside sm. Harmless, so reported and never cleared: a
// dormant project's worktrees are unlisted but may come back, and a
// mark doesn't say which project it is from. With the project list
// short, every mark of a missing project would read as a leftover, so
// the check stands down.
func checkWorktreeBookkeeping(report *doctorReport, projects []project, complete bool) {
	if !complete {
		return
	}
	registry, err := readRegistryFile()
	if err != nil {
		return // checkRegistryFile says why
	}
	known := map[string]bool{}
	dataFiles := 0 // leftover worktrees/<id>.json files
	for _, proj := range projects {
		identities, err := listWorktreeIdentities(proj)
		if err != nil {
			return // an unreadable repo would make every id look orphaned
		}
		ids := map[string]bool{}
		for _, id := range identities {
			known[id.ID] = true
			ids[id.ID] = true
		}
		dir := filepath.Join(projectDataDir(proj.ID), "worktrees")
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			id, isData := strings.CutSuffix(entry.Name(), ".json")
			if isData && !entry.IsDir() && !ids[id] {
				dataFiles++
			}
		}
	}
	marked, leftover := map[string]bool{}, 0
	for _, key := range worktreeMarkKeys {
		ids := map[string]json.RawMessage{}
		if decodeKey(registryPath(), key, registry[key], &ids) != nil {
			continue // checkRegistryFile's territory
		}
		for id := range ids {
			marked[id] = true
			if !known[id] {
				leftover++
			}
		}
	}
	if leftover == 0 && dataFiles == 0 {
		if len(marked) > 0 {
			report.ok(groupState, "bookkeeping", "worktree marks",
				fmt.Sprintf("%d worktree%s marked, all still present", len(marked), plural(len(marked))))
		}
		return
	}
	var parts []string
	if leftover > 0 {
		parts = append(parts, fmt.Sprintf("%d mark%s", leftover, plural(leftover)))
	}
	if dataFiles > 0 {
		parts = append(parts, fmt.Sprintf("%d data file%s", dataFiles, plural(dataFiles)))
	}
	report.warn(groupState, "bookkeeping", "worktree marks",
		strings.Join(parts, " and ")+" belong to worktrees that no longer exist",
		"Harmless, and some may belong to a project that isn't listed right now. "+
			"Removing worktrees with `"+binaryName+" rm` or from the app leaves none behind.")
}

// port-pool leases live in port-pool's own state, keyed by directory,
// and sm only ever provisions/releases them. An allocation whose
// directory is gone means a worktree was removed without a release,
// so the ports stay reserved forever. Reported, never fixed: the file
// belongs to another tool.
func checkPortAllocations(report *doctorReport) {
	global := readGlobalConfigHints()
	if !portPoolEnabled(global) {
		return
	}
	if !portPoolInstalled() {
		report.warn(groupState, "ports", "port pool",
			"enabled in config.json but `port-pool` isn't on PATH, so provisioning is skipped",
			"Install port-pool, or turn the toggle off in the app's Settings.")
		return
	}
	stdout, err := exec.Command("port-pool", "list").Output()
	if err != nil {
		report.warn(groupState, "ports", "port pool", "`port-pool list` failed: "+err.Error(),
			"Run `port-pool list` by hand to see what it says.")
		return
	}
	total, orphans := 0, 0
	for _, dir := range parsePortPoolDirs(string(stdout)) {
		total++
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			orphans++
		}
	}
	if orphans == 0 {
		report.ok(groupState, "ports", "port pool",
			fmt.Sprintf("%d allocation%s, all pointing at directories that exist", total, plural(total)))
		return
	}
	report.warn(groupState, "ports", "port pool",
		fmt.Sprintf("%d of %d allocations point at directories that are gone, so those ports stay reserved",
			orphans, total),
		"Run `port-pool prune` (it owns that state, so "+binaryName+" won't touch it).")
}

// The terrier registry belongs to terrier, and sm only merges it into
// the project list. So this check explains why merged projects might be
// missing (the same terrierTroubleFor ladder the merge warns from). The
// merged projects themselves, gone directories included, are checked
// one by one in checkProjects.
func checkTerrier(report *doctorReport) {
	if !terrierEnabled(readGlobalConfigHints()) {
		return
	}
	listings, trouble := activeTerrierListings()
	if trouble != nil {
		report.warn(groupState, "terrier", "terrier", trouble.summary, trouble.advice)
		return
	}
	report.ok(groupState, "terrier", "terrier",
		fmt.Sprintf("%d registered repo%s merged into the project list", len(listings), plural(len(listings))))
}

// A projects/<id>/ dir that no registered or terrier project claims is
// dormant: terrier rm/prune of a repo sm held config for leaves one
// behind, since the id is all that ties the dir to a path. Reported,
// never fixed. Re-registering the path under terrier resurrects the
// same deterministic id and picks the state back up, and sm can't tell
// a dir that will come back from one that won't.
func checkDormantProjectState(report *doctorReport, projects []project, complete bool) {
	if !complete {
		return // every dir the short list leaves out would read as dormant
	}
	dir := projectsDataDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // absent until a project is configured, so nothing to say
	}
	claimed := make(map[string]bool, len(projects))
	for _, p := range projects {
		claimed[p.ID] = true
	}
	total := 0
	var dormant []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		total++
		if !claimed[entry.Name()] {
			dormant = append(dormant, entry.Name())
		}
	}
	if total == 0 {
		return
	}
	if len(dormant) == 0 {
		report.ok(groupState, "dormant-state", "project state",
			fmt.Sprintf("%d state dir%s, each belonging to a project", total, plural(total)))
		return
	}
	sort.Strings(dormant)
	names := dormant[0]
	if extra := len(dormant) - 1; extra > 0 {
		names += fmt.Sprintf(" and %d more", extra)
	}
	report.warn(groupState, "dormant-state", "project state",
		fmt.Sprintf("%d state %s to no project (%s)", len(dormant),
			pluralize(len(dormant), "dir belongs", "dirs belong"), names),
		"Harmless: it reconnects if terrier lists the repo again (re-added, or the terrier toggle back on). "+
			"Otherwise delete it from "+collapseHome(dir)+" by hand.")
}

// `port-pool list` prints "  <port> -> <dir> (<date>)" per allocation.
// Tolerant on purpose: an unrecognized line is skipped, so a change in
// its output degrades to "no allocations found" instead of a wrong
// diagnosis.
func parsePortPoolDirs(stdout string) []string {
	var dirs []string
	for _, line := range strings.Split(stdout, "\n") {
		_, rest, found := strings.Cut(line, " -> ")
		if !found {
			continue
		}
		dir := strings.TrimSpace(rest)
		if cut := strings.LastIndex(dir, " ("); cut > 0 {
			dir = dir[:cut]
		}
		if strings.HasPrefix(dir, "/") {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

// --- per project ---

// One line per healthy project, and one line per problem otherwise:
// a dozen registered projects would otherwise bury the findings that
// matter under a hundred green ticks. Terrier-sourced projects get the same checks. Only the unregister
// repair is withheld (checkProjectRepo), since that entry belongs to
// terrier. The others act on the repo's own git metadata and sm's
// bookkeeping, which are the same whoever registered the path.
func checkProjects(report *doctorReport, projects []project) {
	if len(projects) == 0 {
		return
	}
	perProject := make([]*doctorReport, len(projects))
	var wg sync.WaitGroup
	for i, proj := range projects {
		wg.Go(func() {
			sub := &doctorReport{}
			checkOneProject(sub, proj)
			perProject[i] = sub
		})
	}
	wg.Wait()
	for i, sub := range perProject {
		if len(sub.findings) == 0 {
			detail := "ok"
			if projects[i].Source != "" {
				detail += dimOut(" (via " + projects[i].Source + ")")
			}
			report.ok(groupProjects, "project", projects[i].Name, detail)
			continue
		}
		for _, f := range sub.findings {
			report.add(f)
		}
	}
}

// Only problems are recorded here; a silent return means the project is
// healthy and the caller prints its single ok line.
func checkOneProject(report *doctorReport, proj project) {
	if !checkProjectRepo(report, proj) {
		return // every check below needs a working repo
	}
	config := readProjectConfig(proj.ID)
	checkProjectConfig(report, proj, config)
	checkProjectDefaultBranch(report, proj, config)
	checkProjectWorktrees(report, proj, config)
	checkProjectScripts(report, proj, config)
	checkProjectWorktreeInclude(report, proj, config)
	checkProjectCarryOver(report, proj, config)
	checkProjectLaunchers(report, proj, config)
	checkIncomingRefs(report, proj)
}

func checkProjectRepo(report *doctorReport, proj project) bool {
	info, err := os.Stat(proj.Path)
	if os.IsNotExist(err) && proj.Source != "" {
		// Not sm's entry to drop, so no repair: terrier prune owns it.
		report.warn(groupProjects, "project-path", proj.Name,
			collapseHome(proj.Path)+" is gone, but "+proj.Source+" still lists it",
			"Restore the directory, or run `terrier prune`.")
		return false
	}
	if os.IsNotExist(err) {
		report.repairable(groupProjects, "project-path", proj.Name, statusFail,
			collapseHome(proj.Path)+" is gone, so every command for this project fails",
			"Restore the directory, or unregister it (`"+binaryName+
				" projects remove "+proj.Name+"`).",
			&repair{
				prompt: "Unregister " + proj.Name + " (" + collapseHome(proj.Path) +
					" is gone)? Its config under projects/ goes too.",
				label:       "unregistered " + proj.Name,
				destructive: true,
				apply: func() error {
					if err := removeProjectRegistration(proj.ID, true); err != nil {
						return err
					}
					// Unlike `projects remove`, doctor has nothing else to
					// report: a state dir that survives is orphaned and
					// undiscoverable, so the failure has to surface.
					return removeProjectState(proj.ID)
				},
			})
		return false
	}
	if err != nil || !info.IsDir() {
		report.fail(groupProjects, "project-path", proj.Name,
			collapseHome(proj.Path)+" isn't a readable directory",
			"Check its permissions, or unregister it ("+unregisterHint(proj)+").")
		return false
	}
	_, primaryPath, err := locateRepo(proj.Path)
	if err != nil && isBareRepo(proj.Path) {
		// A bare repo has no work tree for locateRepo to find, and no
		// primary checkout to compare against; its linked worktrees are
		// checked below like any others.
		return true
	}
	if err != nil {
		report.fail(groupProjects, "project-repo", proj.Name,
			collapseHome(proj.Path)+" is no longer a git repository",
			"Restore the repo, or unregister it ("+unregisterHint(proj)+").")
		return false
	}
	if primaryPath != proj.Path {
		// git always answers with a symlink-free path, and every match in
		// sm is plain string equality against it (resolveContext,
		// resolveWorktreeByDir), so the two ways this can differ are both
		// real breakage, but they need different words and different
		// fixes.
		detail := "registered at " + collapseHome(proj.Path) + ", which is a worktree of " +
			collapseHome(primaryPath) + ", not the repo's primary checkout"
		if sameDirectory(proj.Path, primaryPath) {
			detail = "registered through a symlinked path; git calls the same directory " +
				collapseHome(primaryPath) + ", so nothing run from inside the repo matches it"
		}
		readd := "`" + binaryName + " projects add " + collapseHome(primaryPath) + "`"
		if proj.Source == "terrier" {
			readd = "`terrier add " + collapseHome(primaryPath) + "`"
		}
		report.fail(groupProjects, "project-primary", proj.Name, detail,
			"Unregister it ("+unregisterHint(proj)+") and re-add the resolved path ("+readd+").")
		return false
	}
	return true
}

// The command that unregisters proj, from whichever registry holds it.
func unregisterHint(proj project) string {
	if proj.Source == "terrier" {
		return "`terrier rm " + proj.Name + "`"
	}
	return "`" + binaryName + " projects remove " + proj.Name + "`"
}

func isBareRepo(path string) bool {
	out, err := runGit(path, "rev-parse", "--is-bare-repository")
	return err == nil && strings.TrimSpace(out) == "true"
}

// Whether two paths name the same directory once symlinks are gone
// (/tmp vs /private/tmp, a checkout reached through a symlinked home).
// False when either side can't be resolved. A "can't tell" must not
// read as "same".
func sameDirectory(a, b string) bool {
	resolvedA, errA := filepath.EvalSymlinks(a)
	resolvedB, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && resolvedA == resolvedB
}

func checkProjectConfig(report *doctorReport, proj project, config *projectConfig) {
	path := projectConfigJSONPath(proj.ID)
	if _, err := os.Stat(path); err != nil {
		return // no config at all is fine; defaults apply
	}
	if config != nil {
		return
	}
	// The file is there but readProjectConfig rejected it, which is
	// exactly what the app does, silently, so the user sees their
	// setup script and layout settings simply stop applying.
	report.warn(groupProjects, "project-config", proj.Name,
		"project.json exists but is invalid (bad JSON or no defaultBranch), so its scripts and layout are ignored",
		"Run `"+binaryName+" projects config --default-branch <ref> -p "+proj.Name+"` to rewrite it.")
}

func checkProjectDefaultBranch(report *doctorReport, proj project, config *projectConfig) {
	if primaryRefFor(proj, config) != "" {
		return
	}
	detail := "no default branch resolves, so create has no base to fork from"
	if override := strings.TrimSpace(defaultBranchOverride(config)); override != "" {
		detail = "the configured default branch " + override +
			" doesn't exist, and nothing else resolves either"
	}
	report.warn(groupProjects, "project-branch", proj.Name, detail,
		"Set one with `"+binaryName+" projects config --default-branch <ref> -p "+proj.Name+"`.")
}

// Three ways git's worktree metadata and the disk can disagree, all of
// them producing worktrees that list but don't work.
func checkProjectWorktrees(report *doctorReport, proj project, config *projectConfig) {
	drift, err := findWorktreeDrift(proj, config)
	if err != nil {
		report.fail(groupProjects, "project-worktrees", proj.Name,
			"git can't list this project's worktrees: "+err.Error(),
			"Run `git worktree list` in "+collapseHome(proj.Path)+" to see the failure.")
		return
	}
	if n := len(drift.moved); n > 0 {
		var names []string
		for oldPath, newPath := range drift.moved {
			names = append(names, filepath.Base(oldPath)+" → "+collapseHome(newPath))
		}
		sort.Strings(names)
		report.repairable(groupProjects, "project-moved", proj.Name, statusWarn,
			fmt.Sprintf("%d worktree%s moved without telling git (%s), so git lists the old path as missing",
				n, plural(n), strings.Join(names, ", ")),
			"Re-link it (`git worktree repair <new path>`). Never prune it.",
			&repair{
				label: fmt.Sprintf("re-linked %d moved worktree%s for %s", n, plural(n), proj.Name),
				apply: func() error { return relinkMovedWorktrees(proj, drift.moved) },
			})
	}
	if len(drift.missing) > 0 {
		names := make([]string, len(drift.missing))
		for i, id := range drift.missing {
			names[i] = id.Name
		}
		report.repairable(groupProjects, "project-worktrees", proj.Name, statusWarn,
			fmt.Sprintf("git still lists %d worktree%s whose directory is gone (%s)",
				len(names), plural(len(names)), strings.Join(names, ", ")),
			"Prune the metadata (`git worktree prune`). "+
				"If one was moved, run `git worktree repair <new path>` instead.",
			&repair{
				// Destructive: a checkout moved somewhere doctor doesn't
				// look loses its link to the repo once pruned.
				prompt: "Prune git's record of " + strings.Join(names, ", ") + " in " + proj.Name +
					"? Say no if any of them was moved rather than deleted.",
				label:       "pruned git's worktree metadata for " + proj.Name,
				destructive: true,
				apply:       func() error { return pruneMissingWorktrees(proj, config) },
			})
	}
	if len(drift.strays) > 0 {
		shown := make([]string, len(drift.strays))
		for i, path := range drift.strays {
			shown[i] = collapseHome(path)
		}
		report.warn(groupProjects, "project-strays", proj.Name,
			fmt.Sprintf("%d %s in the managed layout that git doesn't know about (%s)",
				len(shown), pluralize(len(shown), "directory", "directories"),
				strings.Join(shown, ", ")),
			"Adopt it (`"+binaryName+" adopt <path>`) or delete it by hand. "+
				binaryName+" won't guess.")
	}
}

// How one project's git worktree metadata and the disk disagree.
type worktreeDrift struct {
	// Listed by git, directory gone. A locked entry is one git keeps on
	// purpose while its directory is away (prune skips it too), and a
	// moved one is in moved instead.
	missing []worktreeIdentity
	// A missing entry's old path -> the stray directory it moved to. Its
	// .git still points at that entry's metadata: moved by hand, or by a
	// data-folder move whose `git worktree repair` failed. Pruning would
	// sever it.
	moved map[string]string
	// Directories in the managed layout git has no record of: adoptable,
	// deletable, or a half-finished create. Moved ones excluded.
	strays []string
}

func findWorktreeDrift(proj project, config *projectConfig) (worktreeDrift, error) {
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeDrift{}, err
	}
	var drift worktreeDrift
	known := map[string]bool{}
	gone := map[string]bool{}
	for _, id := range identities {
		known[id.Path] = true
		if _, err := os.Stat(id.Path); os.IsNotExist(err) && !id.Locked {
			drift.missing = append(drift.missing, id)
			gone[id.Path] = true
		}
	}
	drift.moved = map[string]string{}
	for _, stray := range findStrayWorktreeDirs(proj, config, known) {
		if old := recordedWorktreePath(stray); gone[old] && drift.moved[old] == "" {
			drift.moved[old] = stray
			continue
		}
		drift.strays = append(drift.strays, stray)
	}
	drift.missing = slices.DeleteFunc(drift.missing, func(id worktreeIdentity) bool {
		return drift.moved[id.Path] != ""
	})
	return drift, nil
}

// A directory sitting in the managed layout that git has no record of.
// Sorted.
func findStrayWorktreeDirs(proj project, config *projectConfig, known map[string]bool) []string {
	var strays []string
	for _, base := range managedBasesFor(proj.Path, config) {
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			path := filepath.Join(base, entry.Name())
			if known[path] {
				continue
			}
			// Managed bases are keyed on the project's directory basename,
			// so a sibling project with the same basename shares one.
			// Only claim a stray whose git metadata points back at us.
			if _, primaryPath, err := locateRepo(path); err == nil &&
				primaryPath != proj.Path {
				continue
			}
			strays = append(strays, path)
		}
	}
	sort.Strings(strays)
	return strays
}

// Where git last saw the linked checkout now at dir: its .git names an
// admin dir in the repo, whose gitdir file records "<checkout>/.git".
// "" when dir isn't a linked checkout or the record can't be read.
func recordedWorktreePath(dir string) string {
	admin := worktreeAdminDir(dir)
	if admin == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(admin, "gitdir"))
	recorded := strings.TrimSpace(string(raw))
	if err != nil || recorded == "" {
		return ""
	}
	if !filepath.IsAbs(recorded) { // worktree.useRelativePaths
		recorded = filepath.Join(admin, recorded)
	}
	return filepath.Dir(recorded)
}

// `git worktree repair` on the new paths, then everything sm keys by
// worktree id carried from the old path's id to the new one, as
// `worktrees move` does. A data-folder move has already re-keyed, which
// leaves nothing at the old id and makes that half a no-op.
func relinkMovedWorktrees(proj project, moved map[string]string) error {
	args := []string{"worktree", "repair", "--"}
	for _, newPath := range moved {
		args = append(args, newPath)
	}
	// git repairs each path on its own and fails if any one failed, so
	// the ones it did re-link are re-keyed whatever it answers.
	_, repairErr := runGit(proj.Path, args...)
	invalidateWorktreeIdentities(proj.ID)
	for oldPath, newPath := range moved {
		now, err := findMovedIdentity(proj, newPath)
		if err != nil {
			continue // not re-linked; the error below says why
		}
		if from := worktreeIDFromPath(oldPath); from != now.ID {
			rekeyWorktree(proj, from, now.ID)
		}
	}
	return repairErr
}

// `git worktree prune`, re-checked at the moment it runs: a moved
// worktree still waiting to be re-linked (its repair failed, or was
// never run) would be severed by it, so the prune stands down. What sm
// keeps per worktree goes with each pruned entry, as with `sm rm`.
func pruneMissingWorktrees(proj project, config *projectConfig) error {
	invalidateWorktreeIdentities(proj.ID)
	drift, err := findWorktreeDrift(proj, config)
	if err != nil {
		return err
	}
	if len(drift.moved) > 0 {
		return errf("a moved worktree in %s needs re-linking first (`git worktree repair <new path>`)", proj.Name)
	}
	if _, err := runGit(proj.Path, "worktree", "prune"); err != nil {
		return err
	}
	invalidateWorktreeIdentities(proj.ID)
	for _, id := range drift.missing {
		forgetWorktree(proj.ID, id.ID)
	}
	return nil
}

// Lifecycle scripts fail late and loudly (mid-create, after the
// worktree exists). A script naming a file that isn't in the repo is
// the common cause, and it's checkable without running anything.
func checkProjectScripts(report *doctorReport, proj project, config *projectConfig) {
	if config == nil {
		return
	}
	for _, script := range []struct{ name, command string }{
		{"setup", config.Scripts.Setup},
		{"teardown", config.Scripts.Teardown},
	} {
		for _, missing := range missingScriptFiles(proj.Path, script.command) {
			report.warn(groupProjects, "project-scripts", proj.Name,
				"the "+script.name+" script runs "+missing+", which isn't in the repo",
				"Fix it with `"+binaryName+" projects config --"+script.name+
					" '<command>' -p "+proj.Name+"`.")
		}
	}
}

// Deliberately conservative: only tokens that unambiguously name a file
// in the repo (an explicit ./ or a bare relative path with a slash and
// no shell syntax in it) are checked, so a command that merely mentions
// a URL or a variable never produces a false alarm.
func missingScriptFiles(projectPath, command string) []string {
	var missing []string
	for _, token := range strings.Fields(command) {
		token = strings.Trim(token, `"'`)
		switch {
		case token == "", strings.HasPrefix(token, "-"):
			continue
		case strings.ContainsAny(token, "$*?`~|&;<>()"):
			continue
		case strings.Contains(token, "://"):
			continue
		}
		relative := strings.TrimPrefix(token, "./")
		if !strings.Contains(relative, "/") || strings.HasPrefix(relative, "/") {
			continue
		}
		if _, err := os.Stat(filepath.Join(projectPath, relative)); os.IsNotExist(err) {
			missing = append(missing, token)
		}
	}
	return missing
}

// .worktreeinclude drives carry-over into every new worktree. A broken
// one doesn't fail create. It degrades to "nothing carried over",
// which looks like the feature is off.
func checkProjectWorktreeInclude(report *doctorReport, proj project, config *projectConfig) {
	path := filepath.Join(proj.Path, worktreeIncludeFile)
	info, err := os.Lstat(path)
	if err != nil {
		return
	}
	if info.IsDir() {
		report.warn(groupProjects, "project-include", proj.Name,
			worktreeIncludeFile+" is a directory, so carry-over resolves nothing",
			"Remove or replace "+collapseHome(path)+".")
		return
	}
	if file, err := os.Open(path); err != nil {
		report.warn(groupProjects, "project-include", proj.Name,
			worktreeIncludeFile+" can't be read ("+err.Error()+"), so nothing is carried into new worktrees",
			"Fix the permissions on "+collapseHome(path)+".")
		return
	} else {
		file.Close()
	}
	if _, err := resolveWorktreeInclude(proj.Path, config); err != nil {
		report.warn(groupProjects, "project-include", proj.Name,
			worktreeIncludeFile+" doesn't resolve: "+err.Error(),
			"Check its patterns against `git ls-files --others`.")
	}
}

// A carry-over entry no checkout has fails every create with "Source
// missing in every checkout", after the worktree already exists. Only
// `carryover add` warns about it today, and a file that has since been
// deleted never gets that warning.
func checkProjectCarryOver(report *doctorReport, proj project, config *projectConfig) {
	if config == nil || len(config.CarryOver) == 0 {
		return
	}
	var missing []string
	for _, entry := range config.CarryOver {
		if !carryOverPathExists(proj, entry.Path) {
			missing = append(missing, entry.Path)
		}
	}
	if len(missing) == 0 {
		return
	}
	report.warn(groupProjects, "project-carryover", proj.Name,
		fmt.Sprintf("carry-over %s %s in no checkout, so new worktrees start without %s",
			pluralize(len(missing), "entry", "entries"), strings.Join(missing, ", ")+
				pluralize(len(missing), " is", " are"),
			pluralize(len(missing), "it", "them")),
		"Restore it in the primary checkout, or drop the entry (`"+binaryName+
			" projects config carryover rm "+shellWord(missing[0])+" -p "+proj.Name+"`).")
}

// Custom launchers fire and forget through /bin/sh, so one whose
// program isn't installed fails with nothing on screen, from the app
// and from `sm open` alike.
func checkProjectLaunchers(report *doctorReport, proj project, config *projectConfig) {
	if config != nil {
		reportMissingLaunchers(report, groupProjects, "project-launchers", proj.Name,
			config.Launchers, "projects config launcher rm", " -p "+proj.Name)
	}
}

// The global launchers, the ones every project's row carries.
func checkGlobalLaunchers(report *doctorReport) {
	reportMissingLaunchers(report, groupState, "launchers", "launchers",
		readGlobalConfigHints().Launchers, "config launcher rm", "")
}

func reportMissingLaunchers(report *doctorReport, group, id, title string, commands []launcherCommand, rm, scope string) {
	for _, missing := range launchersMissingProgram(commands) {
		report.warn(group, id, title,
			"the "+missing.label+" launcher runs "+missing.program+", which isn't installed or on PATH",
			"Install it, or fix the launcher (`"+binaryName+" "+rm+" "+shellWord(missing.label)+scope+
				"`, then add it again).")
	}
}

type missingLauncher struct{ label, program string }

// A label as one shell word, for a fix line meant to be pasted.
func shellWord(s string) string {
	if strings.ContainsAny(s, " \t'\"$`\\") {
		return shellQuote(s)
	}
	return s
}

func launchersMissingProgram(commands []launcherCommand) []missingLauncher {
	var missing []missingLauncher
	for _, c := range commands {
		program := launcherProgram(c.Command)
		if program == "" {
			continue
		}
		if filepath.IsAbs(program) {
			if _, err := os.Stat(program); err == nil {
				continue
			}
		} else if _, err := exec.LookPath(program); err == nil {
			continue
		}
		missing = append(missing, missingLauncher{label: c.Label, program: program})
	}
	return missing
}

// Shell words that aren't programs on PATH.
var shellBuiltins = map[string]bool{
	"cd": true, "exec": true, "command": true, "eval": true, "source": true, ".": true,
	"export": true, "set": true, "if": true, "for": true, "while": true, "case": true,
	"test": true, "[": true, "echo": true, "printf": true, "true": true, "false": true,
	"exit": true, "time": true, "nohup": true, "!": true,
}

// The program a launcher command starts, when that can be told without
// a shell: its first word. "" whenever the command opens with anything
// a shell would interpret first (a variable, an assignment, a quoted
// path with spaces, a builtin, a relative path), so a false alarm is
// never raised.
func launcherProgram(command string) string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return ""
	}
	first := fields[0]
	if unquoted := strings.Trim(first, `"'`); unquoted != first {
		// Quoted and whole (no space inside), or give up.
		if len(first) < 2 || first[0] != first[len(first)-1] {
			return ""
		}
		first = unquoted
	}
	first = expandHome(first)
	switch {
	case first == "", shellBuiltins[first]:
		return ""
	case strings.ContainsAny(first, "$`=(){}|&;<>*?\\"):
		return ""
	case strings.Contains(first, "/") && !filepath.IsAbs(first):
		return "" // relative to the worktree it runs in
	}
	return first
}

// How long a transfer's landing ref may exist before it can only be a
// leftover. A landing sweeps it in a finally within seconds, and a
// mirror's apply the same way.
const incomingRefStale = time.Hour

// refs/shigomori/incoming/<branch> is where a transfer or mirror lands
// a branch before creating the worktree, swept straight after. One that
// outlives its landing (a crash mid-fetch) blocks every later branch
// nested under its name (incoming/feat blocks incoming/feat/x) at git's
// file/directory rule, so that transfer fails.
func checkIncomingRefs(report *doctorReport, proj project) {
	stale := staleIncomingRefs(proj.Path)
	if len(stale) == 0 {
		return
	}
	names := make([]string, len(stale))
	for i, ref := range stale {
		names[i] = strings.TrimPrefix(ref, "refs/shigomori/incoming/")
	}
	report.repairable(groupProjects, "project-incoming", proj.Name, statusWarn,
		fmt.Sprintf("%d transfer landing ref%s left by an interrupted transfer (%s), which can block the next one",
			len(stale), plural(len(stale)), strings.Join(names, ", ")),
		"Delete "+pluralize(len(stale), "it", "them")+". "+
			"The commits stay on the device they came from.",
		&repair{
			prompt:      "Delete " + strings.Join(stale, ", ") + " in " + proj.Name + "?",
			label:       fmt.Sprintf("deleted %d leftover landing ref%s in %s", len(stale), plural(len(stale)), proj.Name),
			destructive: true,
			apply: func() error {
				for _, ref := range stale {
					if _, err := runGit(proj.Path, "update-ref", "-d", "--end-of-options", ref); err != nil {
						return err
					}
				}
				return nil
			},
		})
}

// Landing refs older than incomingRefStale. Refs carry no timestamp, so
// age is the loose ref file's mtime. A packed one has been through a gc
// and is old by definition. A ref in neither (reftable) is left alone.
func staleIncomingRefs(repoPath string) []string {
	stdout, err := runGit(repoPath, "for-each-ref", "--format=%(refname)", "refs/shigomori/incoming/")
	if err != nil || strings.TrimSpace(stdout) == "" {
		return nil
	}
	commonDir, err := runGit(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil
	}
	commonDir = strings.TrimSpace(commonDir)
	packed, _ := os.ReadFile(filepath.Join(commonDir, "packed-refs"))
	var stale []string
	for _, ref := range strings.Fields(stdout) {
		info, err := os.Stat(filepath.Join(commonDir, filepath.FromSlash(ref)))
		switch {
		case err == nil && time.Since(info.ModTime()) >= incomingRefStale:
			stale = append(stale, ref)
		case err != nil && strings.Contains(string(packed), " "+ref+"\n"):
			stale = append(stale, ref)
		}
		// Anything else is fresh, or has an age that can't be read (a
		// reftable repo): a landing may be under way right now.
	}
	return stale
}

// --- version comparison ---

func belowGitFloor(major, minor int) bool {
	return major < minGitMajor || (major == minGitMajor && minor < minGitMinor)
}

// The leading major.minor of a git version string ("2.39.5",
// "2.51.0.1", "2.39.5 (Apple Git-154)"). Only those two matter: the
// floor sm needs is a minor release. ok is false when nothing numeric
// leads. An unparseable minor reads as 0, which is the conservative
// answer for a floor test.
func parseGitVersion(raw string) (major, minor int, ok bool) {
	words := strings.Fields(raw)
	if len(words) == 0 {
		return 0, 0, false
	}
	fields := strings.SplitN(words[0], ".", 3)
	major, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0, 0, false
	}
	if len(fields) > 1 {
		minor, _ = strconv.Atoi(fields[1])
	}
	return major, minor, true
}
