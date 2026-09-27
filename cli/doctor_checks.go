package main

// The `sm doctor` checks: the runner that orders them and the data-dir
// group here, the machine checks in doctor_env.go and the per-project
// checks in doctor_project.go (the command, its rendering, and the
// --fix driver live in cmd_doctor.go). Every check is read-only: it
// either records a finding or attaches a repair closure the driver
// may run later, but never touches disk itself. Order within each
// group is the printed order.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
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
