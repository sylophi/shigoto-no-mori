package main

// sm doctor -- the "why is sm behaving weirdly" command. It answers two
// questions the other commands can only fail at: is this installation
// intact (git, gh, the app bundle behind the binary, PATH, the shell
// hook), and is the state root internally consistent (config and state
// parse, no lock a crashed process left behind, no registry entry
// pointing at a directory that's gone, git's worktree metadata agreeing
// with what's on disk).
//
// Everything here is read-only unless --fix is passed. --fix applies
// only the repairs whose outcome is unambiguous -- delete a stale lock,
// drop a registry entry whose repo no longer exists, `git worktree
// prune` -- and prompts before each one that deletes something (--yes
// skips the prompts). Anything with a judgment call in it (a directory
// git doesn't know about, a setup script naming a missing file, a repo
// that stopped being a repo) is reported with a suggested fix and never
// touched: a doctor that guesses is worse than no doctor.
//
// Exit codes: 0 when nothing failed (warnings included), 1 when any
// check failed.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	statusOK   = "ok"
	statusWarn = "warn"
	statusFail = "fail"
)

// Group titles, also the JSON `group` values. Order here is the render
// order: broadest blast radius first.
const (
	groupEnv      = "Environment"
	groupState    = "State root"
	groupProjects = "Projects"
)

// One line of the checklist. detail is the one-line explanation, fix
// the concrete suggestion (omitted when there's nothing to suggest).
// repair, when set, is what --fix would run; it never travels in the
// JSON document, only its effect does.
type finding struct {
	Group  string `json:"group"`
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
	repair *repair
}

// An unambiguously safe repair. prompt is the yes/no question asked
// before a destructive one; label is the past-tense line reported once
// it ran.
type repair struct {
	prompt      string
	label       string
	destructive bool
	apply       func() error
}

// Findings accumulate here in check order; the renderer groups them
// afterwards, so a check never has to know where its line lands.
type doctorReport struct {
	mu       sync.Mutex
	findings []finding
}

func (r *doctorReport) add(f finding) {
	r.mu.Lock()
	r.findings = append(r.findings, f)
	r.mu.Unlock()
}

func (r *doctorReport) ok(group, id, title, detail string) {
	r.add(finding{Group: group, ID: id, Title: title, Status: statusOK, Detail: detail})
}

func (r *doctorReport) warn(group, id, title, detail, fix string) {
	r.add(finding{Group: group, ID: id, Title: title, Status: statusWarn, Detail: detail, Fix: fix})
}

func (r *doctorReport) fail(group, id, title, detail, fix string) {
	r.add(finding{Group: group, ID: id, Title: title, Status: statusFail, Detail: detail, Fix: fix})
}

func (r *doctorReport) counts() (ok, warn, fail int) {
	for _, f := range r.findings {
		switch f.Status {
		case statusOK:
			ok++
		case statusWarn:
			warn++
		default:
			fail++
		}
	}
	return ok, warn, fail
}

// --- the command ---

func cmdDoctor(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		bools: map[string][]string{"fix": {}, "yes": {"y"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if len(parsed.positionals) > 0 {
		return 2, usageErrf("doctor takes no arguments (flags: --fix, --yes).")
	}
	fix, yes := parsed.bools["fix"], parsed.bools["yes"]
	if yes && !fix {
		return 2, usageErrf("--yes only means anything with --fix.")
	}

	// doctor is noContext, so run() hands over an empty cliContext and
	// never touches the registry -- which is the point: a root this
	// command exists to diagnose must not fail the load before the
	// checks get to describe it. Read it here and degrade to none,
	// because checkRegistryFile reports the parse failure itself.
	ctx.projects, _ = loadProjects()

	report := runDoctorChecks(ctx)
	var repaired []string
	if fix {
		repaired = applyRepairs(report, yes)
		if len(repaired) > 0 {
			// State changed underneath us: re-read the registry and drop
			// the per-project identity memo, then re-run so the printed
			// checklist describes the world after the repairs, not before.
			invalidateAllWorktreeIdentities()
			projects, err := loadProjects()
			if err != nil {
				// Doctor is the command you reach for *because* the
				// registry is broken, and checkRegistryFile already says
				// so; carry on with none rather than refusing to report.
				projects = nil
			}
			report = runDoctorChecks(cliContext{projects: projects})
		}
	}

	_, _, failed := report.counts()
	if jsonMode {
		emitDoctorJSON(report, repaired)
	} else {
		renderDoctorReport(report, repaired, fix)
	}
	if failed > 0 {
		return 1, nil // every failure is already on the checklist
	}
	return 0, nil
}

func emitDoctorJSON(report *doctorReport, repaired []string) {
	okCount, warnCount, failCount := report.counts()
	if repaired == nil {
		repaired = []string{}
	}
	findings := report.findings
	if findings == nil {
		findings = []finding{}
	}
	emit(map[string]any{
		"ok":       failCount == 0,
		"root":     shigomoriRoot(),
		"flavor":   flavor,
		"version":  version,
		"binary":   binaryName,
		"summary":  map[string]int{"ok": okCount, "warn": warnCount, "fail": failCount},
		"repaired": repaired,
		"checks":   findings,
	})
}

// --- rendering ---

func statusGlyph(status string) string {
	switch status {
	case statusOK:
		return greenOut("✓")
	case statusWarn:
		return yellowOut("!")
	default:
		return redOut("✗")
	}
}

func renderDoctorReport(report *doctorReport, repaired []string, fix bool) {
	header := boldOut(binaryName+" doctor") + " " + dimOut(version+" ("+flavor+")") +
		"  root " + cyanOut(collapseHome(shigomoriRoot()))
	out(header)
	out("")

	for _, group := range []string{groupEnv, groupState, groupProjects} {
		var (
			rows  [][]string
			fixes []string
		)
		for _, f := range report.findings {
			if f.Group != group {
				continue
			}
			rows = append(rows, []string{statusGlyph(f.Status), f.Title, f.Detail})
			fixes = append(fixes, f.Fix)
		}
		if len(rows) == 0 {
			continue
		}
		out(boldOut(group))
		for i, line := range alignRows(rows) {
			out("  " + line)
			if fixes[i] != "" {
				out("    " + dimOut("fix: "+fixes[i]))
			}
		}
		out("")
	}

	if len(repaired) > 0 {
		out(boldOut("Repaired"))
		for _, label := range repaired {
			out("  " + greenOut("✓") + " " + label)
		}
		out("")
	}

	okCount, warnCount, failCount := report.counts()
	parts := []string{fmt.Sprintf("%d ok", okCount)}
	if warnCount > 0 {
		parts = append(parts, yellowOut(fmt.Sprintf("%d warning%s", warnCount, plural(warnCount))))
	}
	if failCount > 0 {
		parts = append(parts, redOut(fmt.Sprintf("%d failed", failCount)))
	}
	out(strings.Join(parts, ", "))

	if !fix {
		if n := repairableCount(report); n > 0 {
			out(dimOut(fmt.Sprintf("%d of them can be repaired: run `%s doctor --fix`.", n, binaryName)))
		}
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func repairableCount(report *doctorReport) int {
	n := 0
	for _, f := range report.findings {
		if f.repair != nil {
			n++
		}
	}
	return n
}

// --- --fix ---

// Applies every repair the checks offered, in checklist order. Each
// destructive one is confirmed first, unless --yes; without a terminal
// to ask on, they're skipped with a note rather than assumed. Failures
// are reported and don't stop the rest.
func applyRepairs(report *doctorReport, yes bool) []string {
	var applied []string
	for _, f := range report.findings {
		if f.repair == nil {
			continue
		}
		if f.repair.destructive && !yes {
			if !interactiveStdio() {
				note(dimErr("skipped: " + f.repair.label + " (re-run with --yes, or interactively)"))
				continue
			}
			if !confirmPrompt(f.repair.prompt) {
				note(dimErr("skipped: " + f.repair.label))
				continue
			}
		}
		if err := f.repair.apply(); err != nil {
			note(yellowErr("couldn't " + f.repair.label + ": " + err.Error()))
			continue
		}
		applied = append(applied, f.repair.label)
	}
	return applied
}

func invalidateAllWorktreeIdentities() {
	identityMemoMu.Lock()
	clear(identityMemo)
	identityMemoMu.Unlock()
}

// The registry half of `sm projects remove`, for a project whose repo
// is gone: drop the entry under the state lock, then the per-project
// state dir (config, worktree data), exactly as the app's
// deleteProjectState does. A missing entry is not an error -- the app
// may have removed it between the check and the repair.
func dropProjectRegistration(projectID string) error {
	err := updateRegistryKey(projectsKey, func(raw json.RawMessage) (any, error) {
		var projects []project
		if raw != nil {
			_ = json.Unmarshal(raw, &projects)
		}
		kept := make([]project, 0, len(projects))
		found := false
		for _, p := range projects {
			if p.ID == projectID {
				found = true
				continue
			}
			kept = append(kept, p)
		}
		if !found {
			return nil, nil
		}
		return kept, nil
	})
	if err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(shigomoriRoot(), "projects", projectID))
}
