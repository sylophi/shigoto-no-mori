package main

// sm status -- one worktree, one card. `list` answers "what do I have";
// this answers "where does the worktree I'm standing in stand": how the
// branch sits against its upstream and against the project's base
// branch, what's dirty, what's stashed, what landed last, which ports
// the worktree holds, which lifecycle scripts it would run, and what
// GitHub thinks of the branch.
//
// Everything on the card is a read. The local probes are git plumbing
// the app already has (worktree.go's builders); the only round-trip
// that can hang is the PR lookup, so it starts first, runs under a hard
// deadline, and degrades to a dim reason line instead of blocking the
// card (--no-pr skips it entirely).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// --- porcelain change counts ---

// The staged/unstaged split `list`'s single changedCount collapses.
// Embedded into the card's git object, so the JSON keeps changedCount
// at the name list already uses.
type changeCounts struct {
	Staged     int `json:"staged"`
	Unstaged   int `json:"unstaged"`
	Untracked  int `json:"untracked"`
	Conflicted int `json:"conflicted"`
	Total      int `json:"changedCount"`
}

func (c changeCounts) clean() bool { return c.Total == 0 }

// XY status codes: X is the index side, Y the worktree side. Unmerged
// entries carry a U on either side (plus the AA/DD both-added/
// both-deleted pairs) and count as conflicted rather than as
// staged+unstaged, which would double-count them.
func foldChangeCounts(entries []statusEntry) changeCounts {
	var counts changeCounts
	for _, entry := range entries {
		switch {
		case entry.index == '!' && entry.worktree == '!':
			continue // ignored; only listed with --ignored, never counted
		case entry.index == '?' && entry.worktree == '?':
			counts.Untracked++
		case entry.index == 'U' || entry.worktree == 'U' ||
			(entry.index == 'A' && entry.worktree == 'A') ||
			(entry.index == 'D' && entry.worktree == 'D'):
			counts.Conflicted++
		default:
			if entry.index != ' ' {
				counts.Staged++
			}
			if entry.worktree != ' ' {
				counts.Unstaged++
			}
		}
		counts.Total++
	}
	return counts
}

// Display probe, like changedCount's caller in buildWorktree: an
// unreadable status shows as clean rather than failing the card. Goes
// through gitx's statusEntries so the card and `list` can never read
// the working tree differently.
func readChangeCounts(worktreePath string) changeCounts {
	entries, err := statusEntries(worktreePath)
	if err != nil {
		return changeCounts{}
	}
	return foldChangeCounts(entries)
}

// Stashes live in the repo's common dir, so this counts the whole
// repo's stack, not just entries pushed from here -- the card says so.
func stashCount(worktreePath string) int {
	stdout, err := runGit(worktreePath, "stash", "list")
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(stdout, "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

// --- pull request probe ---

// Long enough for a cold `gh pr list` on a slow link, short enough that
// a wedged gh (no network, a credential helper waiting on a keychain)
// can't hold the card hostage.
const prProbeTimeout = 6 * time.Second

type prChecks struct {
	Total   int `json:"total"`
	Passing int `json:"passing"`
	Failing int `json:"failing"`
	Pending int `json:"pending"`
}

// The PR fields cmd_pr/cmd_merge already share, plus the check rollup
// this card adds.
type prCard struct {
	prSummary
	Checks *prChecks `json:"checks,omitempty"`
}

// One of: a card, a reason there isn't one, "the branch has no PR"
// (both nil/empty), or skipped, which prints no PR row at all.
type prProbe struct {
	card    *prCard
	reason  string
	skipped bool
}

// gh's statusCheckRollup is a mixed array: CheckRun nodes carry
// status+conclusion, StatusContext nodes carry state. Either way one
// node is one verdict.
type checkNode struct {
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
}

func rollupChecks(nodes []checkNode) prChecks {
	var checks prChecks
	for _, node := range nodes {
		verdict := node.State
		if verdict == "" {
			verdict = node.Conclusion
			if node.Status != "COMPLETED" {
				verdict = "PENDING"
			}
		}
		checks.Total++
		switch verdict {
		case "SUCCESS", "NEUTRAL", "SKIPPED":
			checks.Passing++
		case "FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE":
			checks.Failing++
		default:
			checks.Pending++
		}
	}
	return checks
}

// gh's stderr, folded to one short line for the card. The auth failure
// is the one worth naming: it's the common case and its own message is
// four lines of instructions.
func ghProbeReason(stderr string) string {
	if strings.Contains(stderr, "gh auth login") {
		return "gh isn't authenticated"
	}
	for _, line := range strings.Split(stderr, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return truncateRunes(trimmed, 60)
		}
	}
	return "gh failed"
}

// findPullRequest's lookup -- the same args, so the card can't end up
// describing a different PR than `sm merge` acts on -- with the check
// rollup attached and a deadline around it. The deadline is why it
// takes the context form: a status card must never be the command that
// hangs.
func probePullRequest(projectPath, branch string) prProbe {
	if !ghAvailable() {
		return prProbe{reason: "gh isn't installed"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), prProbeTimeout)
	defer cancel()
	stdout, err := runGhContext(ctx, projectPath, prLookupArgs(branch, "statusCheckRollup")...)
	if err != nil {
		if ctx.Err() != nil {
			return prProbe{reason: "gh timed out"}
		}
		return prProbe{reason: ghProbeReason(err.Error())}
	}
	var found []struct {
		prSummary
		StatusCheckRollup []checkNode `json:"statusCheckRollup"`
	}
	if json.Unmarshal([]byte(stdout), &found) != nil {
		return prProbe{reason: "unexpected gh output"}
	}
	if len(found) == 0 {
		return prProbe{}
	}
	card := &prCard{prSummary: found[0].prSummary}
	if checks := rollupChecks(found[0].StatusCheckRollup); checks.Total > 0 {
		card.Checks = &checks
	}
	return prProbe{card: card}
}

// --- the card document ---

type syncJSON struct {
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`
}

type baseJSON struct {
	Ref string `json:"ref"`
	syncJSON
}

type gitStatusJSON struct {
	// null when the branch has no upstream (never pushed, or detached).
	Upstream *syncJSON `json:"upstream"`
	// null when the project's base branch doesn't resolve here.
	Base *baseJSON `json:"base"`
	changeCounts
	// Repo-wide: git keeps one stash stack per repository.
	StashCount int            `json:"stashCount"`
	LastCommit *commitSummary `json:"lastCommit"`
}

type portPoolJSON struct {
	Enabled    bool `json:"enabled"`
	Installed  bool `json:"installed"`
	Configured bool `json:"configured"`
}

type scriptsJSON struct {
	Setup    string `json:"setup,omitempty"`
	Teardown string `json:"teardown,omitempty"`
}

// The card as one document. Identity fields keep worktreeJSON's names
// so a --json consumer can read a status card and a list row with the
// same code.
type statusJSON struct {
	ID          string        `json:"id"`
	ProjectID   string        `json:"projectId"`
	ProjectName string        `json:"projectName"`
	Name        string        `json:"name"`
	Branch      string        `json:"branch"`
	Path        string        `json:"path"`
	IsPrimary   bool          `json:"isPrimary"`
	IsExternal  bool          `json:"isExternal"`
	Detached    bool          `json:"detached"`
	Shelved     bool          `json:"shelved"`
	Git         gitStatusJSON `json:"git"`
	Ports       []portInfo    `json:"ports"`
	PortPool    portPoolJSON  `json:"portPool"`
	Scripts     scriptsJSON   `json:"scripts"`
	// null when the branch has no PR, when the lookup couldn't run --
	// prUnavailable then carries why -- or when --no-pr skipped it,
	// which prSkipped is how a --json consumer tells apart from "this
	// branch has no PR".
	PR            *prCard `json:"pr"`
	PRUnavailable string  `json:"prUnavailable,omitempty"`
	PRSkipped     bool    `json:"prSkipped,omitempty"`
}

// --- rendering ---

// "3h ago" from a commit's ISO date; "" when the date is missing or
// unparseable, and the card drops the parenthetical.
func relativeAge(iso string) string {
	stamp, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return ""
	}
	since := time.Since(stamp)
	day := 24 * time.Hour
	switch {
	case since < time.Minute:
		return "just now"
	case since < time.Hour:
		return fmt.Sprintf("%dm ago", int(since.Minutes()))
	case since < day:
		return fmt.Sprintf("%dh ago", int(since.Hours()))
	case since < 14*day:
		return fmt.Sprintf("%dd ago", int(since/day))
	case since < 60*day:
		return fmt.Sprintf("%dw ago", int(since/(7*day)))
	case since < 365*day:
		return fmt.Sprintf("%dmo ago", int(since/(30*day)))
	default:
		return fmt.Sprintf("%dy ago", int(since/(365*day)))
	}
}

// Ellipsize to max visible columns. Takes unpainted text only -- color
// goes on after the width math, like the help renderer.
func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if max < 2 || len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

// Whether the checked-out branch IS the base branch -- "main" against
// a base ref of "main" or "origin/main".
func onBaseBranch(branch, ref string) bool {
	return branch != "" && (ref == branch || strings.HasSuffix(ref, "/"+branch))
}

func changesLine(counts changeCounts) string {
	if counts.clean() {
		return dimOut("clean")
	}
	var parts []string
	if counts.Staged > 0 {
		parts = append(parts, greenOut(fmt.Sprintf("%d staged", counts.Staged)))
	}
	if counts.Unstaged > 0 {
		parts = append(parts, yellowOut(fmt.Sprintf("%d unstaged", counts.Unstaged)))
	}
	if counts.Untracked > 0 {
		parts = append(parts, dimOut(fmt.Sprintf("%d untracked", counts.Untracked)))
	}
	if counts.Conflicted > 0 {
		parts = append(parts, yellowOut(fmt.Sprintf("%d conflicted", counts.Conflicted)))
	}
	return strings.Join(parts, ", ")
}

func checksLine(checks prChecks) string {
	var parts []string
	if checks.Failing > 0 {
		parts = append(parts, yellowOut(fmt.Sprintf("%d failing", checks.Failing)))
	}
	if checks.Pending > 0 {
		parts = append(parts, dimOut(fmt.Sprintf("%d pending", checks.Pending)))
	}
	if checks.Passing > 0 {
		parts = append(parts, greenOut(fmt.Sprintf("%d passing", checks.Passing)))
	}
	return strings.Join(parts, ", ")
}

func prLine(card *prCard, width int) string {
	state := strings.ToLower(card.State)
	label := dimOut(state)
	switch state {
	case "open":
		label = greenOut(state)
		if card.IsDraft {
			label = dimOut("draft")
		}
	case "merged":
		label = cyanOut(state)
	}
	line := cyanOut(fmt.Sprintf("#%d", card.Number)) + " " + label +
		"  " + truncateRunes(card.Title, width)
	if card.Checks != nil {
		line += "  " + checksLine(*card.Checks)
	}
	return line
}

// The label column plus its two-space gutter, and the room the rows
// that append something after their value need for it: the divergence
// cell on branch, the age parenthetical on commit, the checks summary
// on pr. Named so a change to one of those suffixes has one place to
// move rather than a bare number at the call site.
const (
	statusLabelWidth  = 12
	statusSyncSuffix  = 12
	statusAgeSuffix   = 20
	statusCheckSuffix = 24
)

// Header line plus an aligned label/value block. Every value is painted
// after its width is fixed; alignRows measures visible width, so the
// column never drifts.
func statusCard(status statusJSON, accent string) string {
	// The longest value still has to fit the terminal.
	valueWidth := helpWidth() - statusLabelWidth

	title := status.Name
	if stdoutColor {
		title = boldOut(title)
	}
	project := status.ProjectName
	if accent != "" {
		project = codeOut(project, accent)
	}
	header := project + dimOut("/") + title
	flags := worktreeFlags(status.IsPrimary, status.IsExternal, status.Shelved)
	if status.Detached {
		flags = append(flags, "detached HEAD")
	}
	if len(flags) > 0 {
		header += "  " + dimOut("("+strings.Join(flags, ", ")+")")
	}

	var rows [][]string
	row := func(label, value string) {
		if value != "" {
			rows = append(rows, []string{dimOut(label), value})
		}
	}

	row("path", dimOut(truncateRunes(collapseHome(status.Path), valueWidth)))
	branch := cyanOut(truncateRunes(status.Branch, valueWidth-statusSyncSuffix))
	if status.Git.Upstream != nil {
		branch += "  " + divergenceCell(outPalette,
			status.Git.Upstream.Ahead, status.Git.Upstream.Behind, "synced")
	} else if !status.Detached {
		branch += "  " + dimOut("local")
	}
	row("branch", branch)
	// Standing on the base branch, the base row only restates the
	// upstream one (origin/main vs main), so the card drops it. --json
	// keeps it either way.
	if base := status.Git.Base; base != nil && !onBaseBranch(status.Branch, base.Ref) {
		row("base", dimOut(base.Ref)+"  "+divergenceCell(outPalette, base.Ahead, base.Behind, "even"))
	}
	row("changes", changesLine(status.Git.changeCounts))
	if status.Git.StashCount > 0 {
		row("stash", fmt.Sprintf("%d", status.Git.StashCount)+dimOut(" (repo-wide)"))
	}
	if commit := status.Git.LastCommit; commit != nil {
		line := yellowOut(commit.Hash) + "  " + truncateRunes(commit.Subject, valueWidth-statusAgeSuffix)
		if age := relativeAge(commit.Date); age != "" {
			line += dimOut("  (" + age + ")")
		}
		row("commit", line)
	}
	if len(status.Ports) > 0 {
		var cells []string
		for _, port := range status.Ports {
			cells = append(cells, dimOut(port.Name+" ")+fmt.Sprintf("%d", port.Port))
		}
		row("ports", strings.Join(cells, "  "))
	} else if status.PortPool.Configured {
		row("ports", dimOut("none provisioned"))
	}
	row("setup", dimOut(truncateRunes(status.Scripts.Setup, valueWidth)))
	row("teardown", dimOut(truncateRunes(status.Scripts.Teardown, valueWidth)))
	switch {
	case status.PRSkipped:
	case status.PR != nil:
		row("pr", prLine(status.PR, valueWidth-statusCheckSuffix))
	case status.PRUnavailable != "":
		row("pr", dimOut("unavailable ("+status.PRUnavailable+")"))
	default:
		row("pr", dimOut("none"))
	}

	lines := append([]string{header}, alignRows(rows)...)
	// The block sits under the header, indented like the help sections.
	for i := 1; i < len(lines); i++ {
		lines[i] = strings.Repeat(" ", helpIndent) + lines[i]
	}
	return strings.Join(lines, "\n")
}

func cmdStatus(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.bools["no-pr"] = nil
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	// The PR lookup is the only round-trip that leaves the machine;
	// start it before the local probes so it runs underneath them.
	probes := make(chan prProbe, 1)
	go func() {
		switch {
		case parsed.bools["no-pr"]:
			probes <- prProbe{skipped: true}
		case id.Detached || id.Branch == unknownBranch:
			probes <- prProbe{reason: "no branch to look up"}
		default:
			probes <- probePullRequest(proj.Path, id.Branch)
		}
	}()

	// Every local probe is independent, so none of them waits on
	// another -- including the two that read files rather than spawn
	// git.
	var (
		counts   changeCounts
		stashes  int
		commits  []commitSummary
		upstream remoteSync
		base     *baseJSON
		build    buildContext
		ports    []portInfo
		pool     portPoolJSON
		wg       sync.WaitGroup
	)
	wg.Add(6)
	go func() { defer wg.Done(); counts = readChangeCounts(id.Path) }()
	go func() { defer wg.Done(); stashes = stashCount(id.Path) }()
	go func() { defer wg.Done(); commits = listCommits(id.Path, 0, 1) }()
	go func() { defer wg.Done(); upstream = getRemoteSync(id.Path) }()
	go func() {
		defer wg.Done()
		// One read of the project's remotes, base ref, config, and
		// shelved set -- the same context list builds its rows from --
		// then the divergence it exists for here.
		build = loadBuildContext(proj)
		if ahead, behind, ok := aheadBehind(id.Path, build.primaryRef); ok {
			base = &baseJSON{Ref: build.primaryRef, syncJSON: syncJSON{Ahead: ahead, Behind: behind}}
		}
	}()
	go func() {
		defer wg.Done()
		// One read of port-pool.config.json answers both "which ports
		// does this worktree hold" and "is it configured at all".
		config := readPortPoolConfig(id.Path)
		ports = provisionedPorts(id.Path, config)
		pool = portPoolJSON{
			Enabled:    portPoolEnabled(readGlobalConfigHints()),
			Installed:  portPoolInstalled(),
			Configured: config.configured(),
		}
	}()
	wg.Wait()

	status := statusJSON{
		ID:          id.ID,
		ProjectID:   id.ProjectID,
		ProjectName: proj.Name,
		Name:        id.Name,
		Branch:      id.Branch,
		Path:        id.Path,
		IsPrimary:   id.IsPrimary,
		IsExternal:  id.IsExternal,
		Detached:    id.Detached,
		Shelved:     shelvedFlag(id, build),
		Git: gitStatusJSON{
			Base:         base,
			changeCounts: counts,
			StashCount:   stashes,
		},
		Ports:    ports,
		PortPool: pool,
	}
	if upstream.hasUpstream {
		status.Git.Upstream = &syncJSON{Ahead: upstream.ahead, Behind: upstream.behind}
	}
	if len(commits) > 0 {
		status.Git.LastCommit = &commits[0]
	}
	if config := build.config; config != nil {
		status.Scripts = scriptsJSON{Setup: config.Scripts.Setup, Teardown: config.Scripts.Teardown}
	}

	probe := <-probes
	status.PR = probe.card
	status.PRSkipped = probe.skipped
	if probe.card == nil && probe.reason != "" {
		status.PRUnavailable = probe.reason
	}

	if jsonMode {
		emit(status)
		return 0, nil
	}
	// Icon work for the header's project accent, and only on the path
	// that paints it.
	accent := ""
	if stdoutColor {
		accent = projectColorCode(proj)
	}
	out(statusCard(status, accent))
	return 0, nil
}
