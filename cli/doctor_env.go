package main

// The `sm doctor` checks on the machine itself (git, gh, the app
// bundle, PATH, the shell hook), plus the git version floor they read
// against. See doctor_checks.go for the driver and the rules every
// check follows.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

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
