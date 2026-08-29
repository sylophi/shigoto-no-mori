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
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// --- checks ---

func runDoctorChecks(projects []project) *doctorReport {
	report := &doctorReport{}
	checkEnvironment(report)
	checkStateRoot(report, projects)
	checkProjects(report, projects)
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
		report.fail(groupEnv, "git", "git", "not runnable -- every command in sm shells out to it",
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
			"not on PATH -- pr, merge, and land can't talk to GitHub without it",
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
			"dev build ("+binaryName+" "+version+") -- runs from a checkout, no installed bundle")
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
		report.warn(groupEnv, "app", "app",
			"no installed app bundle found -- update, app, and the port-pool toggle have nothing behind them",
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
			"app is "+appVersion+" but this CLI is "+version+" -- they ship together, so one of them is stale",
			"Run `"+binaryName+" update`, or re-link the CLI from the app's Settings.")
	default:
		report.ok(groupEnv, "app", "app", appVersion+" at "+collapseHome(bundle))
	}
}

// The conventional install locations, for the case where the CLI on
// PATH is NOT the bundle's own copy (installedBundlePath refuses those,
// on purpose -- see updater.go). Goes through the launcher catalog's
// scan so there's one list of where an .app can live.
func findInstalledBundle() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	return bundlePathFor(appExecutableName + ".app")
}

// CFBundleShortVersionString, via `defaults` -- Info.plist is binary,
// and reading it any other way would mean a plist parser. "" when it
// can't be read; every caller treats that as "unknown", never as a
// mismatch.
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
			"no `"+binaryName+"` on PATH -- this run came from an explicit path",
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
			"not installed -- cd and create open a subshell instead of moving your shell",
			"Run `"+binaryName+" shell install`.")
	default:
		detail := "installed for " + strings.Join(installed, ", ")
		if cdDirectiveFile() == "" {
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

// --- state root ---

func checkStateRoot(report *doctorReport, projects []project) {
	if !checkRootDir(report) {
		return // nothing below can mean anything without a root
	}
	checkGlobalConfig(report)
	checkRegistryFile(report)
	checkStaleLocks(report)
	checkStagingLock(report)
	checkShelvedEntries(report, projects)
	checkPortAllocations(report)
	checkTerrier(report)
}

// access(2)'s W_OK. Go's syscall package doesn't name the mode bits,
// and a bare 0x2 at the call site says nothing.
const writeOK = 0x2

func checkRootDir(report *doctorReport) bool {
	root := shigomoriRoot()
	source := "default for the " + flavor + " flavor"
	if os.Getenv("SHIGOMORI_ROOT") != "" {
		source = "from SHIGOMORI_ROOT"
	}
	info, err := os.Stat(root)
	switch {
	case os.IsNotExist(err):
		report.warn(groupState, "root", "root",
			collapseHome(root)+" doesn't exist yet ("+source+") -- nothing is registered",
			"Add a project (`"+binaryName+" projects add`) and it will be created.")
		return false
	case err != nil:
		report.fail(groupState, "root", "root",
			collapseHome(root)+" can't be read: "+err.Error(),
			"Check the permissions on "+collapseHome(root)+".")
		return false
	case !info.IsDir():
		report.fail(groupState, "root", "root",
			collapseHome(root)+" is a file, not a directory ("+source+")",
			"Move it aside, or point SHIGOMORI_ROOT somewhere else.")
		return false
	}
	if syscall.Access(root, writeOK) != nil {
		report.fail(groupState, "root", "root",
			collapseHome(root)+" isn't writable, so no command that changes state can work",
			"Fix its ownership or permissions.")
		return true
	}
	report.ok(groupState, "root", "root", collapseHome(root)+" "+dimOut("("+source+")"))
	return true
}

func checkGlobalConfig(report *doctorReport) {
	path := configJSONPath()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		report.ok(groupState, "config", "config.json", "absent -- defaults apply")
		return
	}
	if err != nil {
		report.fail(groupState, "config", "config.json", "unreadable: "+err.Error(),
			"Fix the permissions on "+collapseHome(path)+".")
		return
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		report.fail(groupState, "config", "config.json",
			"isn't valid JSON, so every global preference is silently ignored",
			"Repair the JSON in "+collapseHome(path)+", or delete it to fall back to defaults.")
		return
	}
	var known globalConfig
	if json.Unmarshal(raw, &known) != nil {
		report.warn(groupState, "config", "config.json",
			"parses, but a field has the wrong type and is being dropped",
			"Check "+collapseHome(path)+" against the app's Settings.")
		return
	}
	report.ok(groupState, "config", "config.json", fmt.Sprintf("valid, %d key%s", len(probe), plural(len(probe))))
}

func checkRegistryFile(report *doctorReport) {
	// registry.json is the file that matters here: projects and shelf
	// flags moved out of state.json, which now holds only UI history.
	// ensureRegistrySplit runs first so a root still in the old shape is
	// drained and judged on what sm will actually read.
	if err := ensureRegistrySplit(); err != nil {
		report.fail(groupState, "registry", "registry.json",
			"can't be split out of state.json: "+err.Error(),
			"Fix the permissions on "+collapseHome(shigomoriRoot())+".")
		return
	}
	path := registryPath()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		report.ok(groupState, "registry", "registry.json", "absent -- no projects registered yet")
		return
	}
	if err != nil {
		report.fail(groupState, "registry", "registry.json", "unreadable: "+err.Error(),
			"Fix the permissions on "+collapseHome(path)+".")
		return
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(raw, &all) != nil {
		report.fail(groupState, "registry", "registry.json",
			"isn't valid JSON, so every registered project is invisible to sm and the app",
			"Repair the JSON in "+collapseHome(path)+" (it holds the project registry).")
		return
	}
	var projects []project
	if entry, ok := all[projectsKey]; ok && json.Unmarshal(entry, &projects) != nil {
		report.fail(groupState, "registry", "registry.json",
			"the projects list has the wrong shape, so no project resolves",
			"Repair the projects array in "+collapseHome(path)+".")
		return
	}
	malformed := 0
	for _, p := range projects {
		if p.ID == "" || p.Path == "" {
			malformed++
		}
	}
	if malformed > 0 {
		report.warn(groupState, "registry", "registry.json",
			fmt.Sprintf("%d registry %s missing an id or path", malformed,
				pluralize(malformed, "entry is", "entries are")),
			"Remove the incomplete entries from "+collapseHome(path)+".")
		return
	}
	report.ok(groupState, "registry", "registry.json",
		fmt.Sprintf("valid, %d project%s registered", len(projects), plural(len(projects))))
}

// Advisory locks (state.go's protocol) are created and unlinked around
// a read-modify-write measured in milliseconds. One that has sat there
// past lockStale belonged to a process that died holding it, and it
// costs every writer the full lock timeout until something breaks it.
func checkStaleLocks(report *doctorReport) {
	locks := findStaleLocks(shigomoriRoot())
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
		"Delete it (`"+binaryName+" doctor --fix`); the process that took it is gone.",
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

// Only the state root's own tree is walked, and only where locks are
// ever taken: the root itself, the per-project dirs, and iconCache/
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
	raw, err := os.ReadFile(path)
	if err != nil {
		return // absent is the normal case; no line for it
	}
	pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw)))
	if convErr == nil && pidAlive(pid) {
		report.ok(groupState, "staging-lock", "update staging",
			fmt.Sprintf("in progress (pid %d)", pid))
		return
	}
	detail := "left behind by a crashed update"
	if convErr == nil {
		detail += fmt.Sprintf(" (pid %d is gone)", pid)
	}
	report.repairable(groupState, "staging-lock", "update staging", statusWarn,
		detail+", so `"+binaryName+" update` refuses to run",
		"Delete "+collapseHome(path)+" (`"+binaryName+" doctor --fix`).",
		&repair{
			prompt:      "Delete the stale update staging lock at " + collapseHome(path) + "?",
			label:       "deleted the stale update staging lock",
			destructive: true,
			apply:       func() error { return os.Remove(path) },
		})
}

// shelvedWorktrees keys are path-derived worktree ids. Ids that match
// nothing are harmless but accumulate forever, and they're the cheapest
// signal that worktrees were removed outside sm.
func checkShelvedEntries(report *doctorReport, projects []project) {
	shelved := readShelvedSet()
	if len(shelved) == 0 {
		return
	}
	known := map[string]bool{}
	for _, proj := range projects {
		identities, err := listWorktreeIdentities(proj)
		if err != nil {
			return // an unreadable repo would make every id look orphaned
		}
		for _, id := range identities {
			known[id.ID] = true
		}
	}
	orphans := 0
	for id := range shelved {
		if !known[id] {
			orphans++
		}
	}
	if orphans == 0 {
		report.ok(groupState, "shelved", "shelved marks",
			fmt.Sprintf("%d worktree%s marked out of focus, all still present", len(shelved), plural(len(shelved))))
		return
	}
	report.warn(groupState, "shelved", "shelved marks",
		fmt.Sprintf("%d out-of-focus mark%s belong to worktrees that no longer exist",
			orphans, plural(orphans)),
		"Harmless leftovers; unshelving from the app clears them, or edit "+
			collapseHome(registryPath())+".")
}

// port-pool leases live in port-pool's own state, keyed by directory,
// and sm only ever provisions/releases them. An allocation whose
// directory is gone means a worktree was removed without a release --
// the ports stay reserved forever. Reported, never fixed: the file
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
// missing (the same terrierTroubleFor ladder the merge warns from) and
// reports entries whose directory is gone -- never fixes anything,
// since `terrier prune` owns that. This is also the only doctor
// coverage terrier projects get: checkProjects filters them out so its
// repairs can't touch entries sm doesn't own.
func checkTerrier(report *doctorReport) {
	if !terrierEnabled(readGlobalConfigHints()) {
		return
	}
	listings, trouble := activeTerrierListings()
	if trouble != nil {
		report.warn(groupState, "terrier", "terrier", trouble.summary, trouble.advice)
		return
	}
	gone := 0
	for _, t := range listings {
		if _, err := os.Stat(t.Path); os.IsNotExist(err) {
			gone++
		}
	}
	if gone > 0 {
		report.warn(groupState, "terrier", "terrier",
			fmt.Sprintf("%d of %d registered repos point at directories that are gone",
				gone, len(listings)),
			"Run `terrier prune` (it owns that registry, so "+binaryName+" won't touch it).")
		return
	}
	report.ok(groupState, "terrier", "terrier",
		fmt.Sprintf("%d registered repo%s merged into the project list", len(listings), plural(len(listings))))
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
// matter under a hundred green ticks.
func checkProjects(report *doctorReport, projects []project) {
	// Registry entries only: the terrier-sourced merges get their
	// aggregate coverage in checkTerrier, and the repairs here
	// (unregister + state-dir delete) must never act on an entry sm
	// doesn't own.
	owned := make([]project, 0, len(projects))
	for _, p := range projects {
		if p.Source == "" {
			owned = append(owned, p)
		}
	}
	projects = owned
	if len(projects) == 0 {
		return
	}
	perProject := make([]*doctorReport, len(projects))
	var wg sync.WaitGroup
	for i, proj := range projects {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sub := &doctorReport{}
			checkOneProject(sub, proj)
			perProject[i] = sub
		}()
	}
	wg.Wait()
	for i, sub := range perProject {
		if len(sub.findings) == 0 {
			report.ok(groupProjects, "project", projects[i].Name, "ok")
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
}

func checkProjectRepo(report *doctorReport, proj project) bool {
	info, err := os.Stat(proj.Path)
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
			"Check its permissions, or unregister the project.")
		return false
	}
	_, primaryPath, err := locateRepo(proj.Path)
	if err != nil {
		report.fail(groupProjects, "project-repo", proj.Name,
			collapseHome(proj.Path)+" is no longer a git repository",
			"Restore the repo, or unregister it (`"+binaryName+" projects remove "+proj.Name+"`).")
		return false
	}
	if primaryPath != proj.Path {
		// git always answers with a symlink-free path, and every match in
		// sm is plain string equality against it (resolveContext,
		// resolveWorktreeByDir), so the two ways this can differ are both
		// real breakage -- but they need different words and different
		// fixes.
		detail := "registered at " + collapseHome(proj.Path) + ", which is a worktree of " +
			collapseHome(primaryPath) + ", not the repo's primary checkout"
		if sameDirectory(proj.Path, primaryPath) {
			detail = "registered through a symlinked path; git calls the same directory " +
				collapseHome(primaryPath) + ", so nothing run from inside the repo matches it"
		}
		report.fail(groupProjects, "project-primary", proj.Name, detail,
			"Unregister it and re-add the resolved path (`"+binaryName+
				" projects add "+collapseHome(primaryPath)+"`).")
		return false
	}
	return true
}

// Whether two paths name the same directory once symlinks are gone
// (/tmp vs /private/tmp, a checkout reached through a symlinked home).
// False when either side can't be resolved -- a "can't tell" must not
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
	// exactly what the app does -- silently, so the user sees their
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
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		report.fail(groupProjects, "project-worktrees", proj.Name,
			"git can't list this project's worktrees: "+err.Error(),
			"Run `git worktree list` in "+collapseHome(proj.Path)+" to see the failure.")
		return
	}
	var missing []string
	known := map[string]bool{}
	for _, id := range identities {
		known[id.Path] = true
		if _, statErr := os.Stat(id.Path); os.IsNotExist(statErr) {
			missing = append(missing, id.Name)
		}
	}
	if len(missing) > 0 {
		projectPath := proj.Path
		report.repairable(groupProjects, "project-worktrees", proj.Name, statusWarn,
			fmt.Sprintf("git still lists %d worktree%s whose directory is gone (%s)",
				len(missing), plural(len(missing)), strings.Join(missing, ", ")),
			"Prune the metadata (`"+binaryName+" doctor --fix`, or `git worktree prune`).",
			&repair{
				label: "pruned git's worktree metadata for " + proj.Name,
				apply: func() error {
					_, err := runGit(projectPath, "worktree", "prune")
					return err
				},
			})
	}
	// The mirror image: a directory sitting in the managed layout that
	// git has no record of. Adoptable, deletable, or a half-finished
	// create -- sm can't tell, so it only points.
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
			strays = append(strays, collapseHome(path))
		}
	}
	if len(strays) > 0 {
		sort.Strings(strays)
		report.warn(groupProjects, "project-strays", proj.Name,
			fmt.Sprintf("%d %s in the managed layout that git doesn't know about (%s)",
				len(strays), pluralize(len(strays), "directory", "directories"),
				strings.Join(strays, ", ")),
			"Adopt it (`"+binaryName+" adopt <path>`) or delete it by hand -- "+
				binaryName+" won't guess.")
	}
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
// one doesn't fail create -- it degrades to "nothing carried over",
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
