package main

// The `sm doctor` checks run per registered project. See
// doctor_checks.go for the driver and the rules every check follows.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

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
			"If it moved, point the project at it (`"+binaryName+" projects relocate "+
				proj.Name+" <new-path>`). Otherwise restore the directory, or unregister it (`"+
				binaryName+" projects remove "+proj.Name+"`).",
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
