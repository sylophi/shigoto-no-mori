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
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
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

// XY status codes (git status --porcelain=v1): X is the index side, Y
// the worktree side. Unmerged entries carry a U on either side (plus
// the AA/DD both-added/both-deleted pairs) and count as conflicted
// rather than as staged+unstaged, which would double-count them.
func parseChangeCounts(porcelain string) changeCounts {
	var counts changeCounts
	for _, line := range strings.Split(porcelain, "\n") {
		if len(line) < 2 {
			continue
		}
		index, worktree := line[0], line[1]
		switch {
		case index == '!' && worktree == '!':
			continue // ignored; only listed with --ignored, never counted
		case index == '?' && worktree == '?':
			counts.Untracked++
		case index == 'U' || worktree == 'U' ||
			(index == 'A' && worktree == 'A') || (index == 'D' && worktree == 'D'):
			counts.Conflicted++
		default:
			if index != ' ' {
				counts.Staged++
			}
			if worktree != ' ' {
				counts.Unstaged++
			}
		}
		counts.Total++
	}
	return counts
}

// Display probe, like changedCount's caller in buildWorktree: an
// unreadable status shows as clean rather than failing the card.
func readChangeCounts(worktreePath string) changeCounts {
	stdout, err := runGit(worktreePath, "status", "--porcelain=v1")
	if err != nil {
		return changeCounts{}
	}
	return parseChangeCounts(stdout)
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

// The two-sided form of behindPrimary: how far HEAD has moved past a
// ref and how far the ref has moved past HEAD. ok is false when the ref
// doesn't resolve here (a base branch that was never fetched) or HEAD
// is unborn, and the card drops the row rather than printing zeroes.
func divergenceFrom(worktreePath, ref string) (ahead, behind int, ok bool) {
	if ref == "" {
		return 0, 0, false
	}
	stdout, err := runGit(worktreePath, "rev-list", "--left-right", "--count", "HEAD..."+ref)
	if err != nil {
		return 0, 0, false
	}
	fields := strings.Fields(strings.TrimSpace(stdout))
	if len(fields) < 2 {
		return 0, 0, false
	}
	ahead, _ = strconv.Atoi(fields[0])
	behind, _ = strconv.Atoi(fields[1])
	return ahead, behind, true
}

// --- provisioned ports ---

// port-pool.config.json, the file portPoolConfigured already checks:
// which port names the project allocates, and the env files (var name
// -> template) port-pool writes them into.
type portPoolConfig struct {
	PortNames []string                     `json:"portNames"`
	EnvFiles  map[string]map[string]string `json:"envFiles"`
}

type portInfo struct {
	Name string `json:"name"`
	Port int    `json:"port"`
	File string `json:"file"`
	Key  string `json:"key"`
}

// KEY=VALUE lines from a dotenv file: comments, blanks, `export `
// prefixes, and surrounding quotes off. Deliberately not a full dotenv
// parser -- these files are machine-written by port-pool.
func parseEnvAssignments(content string) map[string]string {
	env := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		trimmed = strings.TrimPrefix(trimmed, "export ")
		key, value, found := strings.Cut(trimmed, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		env[strings.TrimSpace(key)] = value
	}
	return env
}

// The value each declared port name currently holds, read back out of
// the env files rather than out of port-pool's own state -- the files
// are the contract both sides already agree on. Only whole-value
// templates ("${renderer}") can be reversed; a name embedded in a
// larger string (a URL, say) goes unreported instead of guessed at.
// First file that carries a name wins, so a name duplicated across env
// files is reported once.
func matchPorts(config portPoolConfig, files map[string]string) []portInfo {
	byTemplate := map[string]string{}
	for _, name := range config.PortNames {
		byTemplate["${"+name+"}"] = name
	}
	ports := []portInfo{}
	seen := map[string]bool{}
	for _, file := range sortedKeys(config.EnvFiles) {
		content, ok := files[file]
		if !ok {
			continue
		}
		env := parseEnvAssignments(content)
		for _, key := range sortedKeys(config.EnvFiles[file]) {
			name, isPort := byTemplate[config.EnvFiles[file][key]]
			if !isPort || seen[name] {
				continue
			}
			port, err := strconv.Atoi(env[key])
			if err != nil || port <= 0 {
				continue
			}
			seen[name] = true
			ports = append(ports, portInfo{Name: name, Port: port, File: file, Key: key})
		}
	}
	return ports
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func provisionedPorts(worktreePath string) []portInfo {
	raw, err := os.ReadFile(filepath.Join(worktreePath, "port-pool.config.json"))
	if err != nil {
		return []portInfo{}
	}
	var config portPoolConfig
	if json.Unmarshal(raw, &config) != nil {
		return []portInfo{}
	}
	files := map[string]string{}
	for name := range config.EnvFiles {
		if content, err := os.ReadFile(filepath.Join(worktreePath, name)); err == nil {
			files[name] = string(content)
		}
	}
	return matchPorts(config, files)
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

// findPullRequest's lookup (gh's server-side --head filter, any state)
// with the check rollup attached and a deadline around it. Doesn't go
// through runGh: that one is unbounded, and a status card must never be
// the command that hangs.
func probePullRequest(projectPath, branch string) prProbe {
	if _, err := exec.LookPath("gh"); err != nil {
		return prProbe{reason: "gh isn't installed"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), prProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh",
		"pr", "list", "--state", "all", "--head", branch, "--limit", "1",
		"--json", "number,title,state,isDraft,url,statusCheckRollup")
	cmd.Dir = projectPath
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	vlog("[gh] pr list --head %s (deadline %s)", branch, prProbeTimeout)
	if err != nil {
		if ctx.Err() != nil {
			return prProbe{reason: "gh timed out"}
		}
		return prProbe{reason: ghProbeReason(stderr.String())}
	}
	var found []struct {
		prSummary
		StatusCheckRollup []checkNode `json:"statusCheckRollup"`
	}
	if json.Unmarshal(stdout.Bytes(), &found) != nil {
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
	// null when the branch has no PR, or when the lookup couldn't run --
	// prUnavailable then carries why.
	PR            *prCard `json:"pr"`
	PRUnavailable string  `json:"prUnavailable,omitempty"`
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

// The ↑ahead ↓behind cell, in `list`'s vocabulary and colors so a card
// and a table row can't describe the same divergence differently. even
// is the label for "no divergence at all".
func divergenceCell(p palette, ahead, behind int, even string) string {
	if ahead == 0 && behind == 0 {
		return p.green(even)
	}
	cell := ""
	if ahead > 0 {
		cell = p.cyan(fmt.Sprintf("↑%d", ahead))
	}
	if behind > 0 {
		if cell != "" {
			cell += " "
		}
		cell += p.yellow(fmt.Sprintf("↓%d", behind))
	}
	return cell
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
	if checks.Passing > 0 && len(parts) == 0 {
		return greenOut(fmt.Sprintf("%d passing", checks.Passing))
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

// Header line plus an aligned label/value block. Every value is painted
// after its width is fixed; alignRows measures visible width, so the
// column never drifts.
func statusCard(status statusJSON, probe prProbe, accent string) string {
	width := helpWidth()
	// The label column plus its two-space gutter, so the longest value
	// still fits the terminal.
	valueWidth := width - 12

	title := status.Name
	if stdoutColor {
		title = boldOut(title)
	}
	project := status.ProjectName
	if accent != "" {
		project = codeOut(project, accent)
	}
	header := project + dimOut("/") + title
	// primary before external, and never both: the primary checkout
	// isn't under the managed base either, and calling it external would
	// only confuse (flagsCell makes the same call).
	var flags []string
	if status.IsPrimary {
		flags = append(flags, "primary")
	} else if status.IsExternal {
		flags = append(flags, "external")
	}
	if status.Shelved {
		flags = append(flags, "shelved")
	}
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
	branch := cyanOut(truncateRunes(status.Branch, valueWidth-12))
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
		line := yellowOut(commit.Hash) + "  " + truncateRunes(commit.Subject, valueWidth-20)
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
	case probe.skipped:
	case status.PR != nil:
		row("pr", prLine(status.PR, valueWidth-24))
	case probe.reason != "":
		row("pr", dimOut("unavailable ("+probe.reason+")"))
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

	// One read of the project's remotes, base ref, and shelved set --
	// the same context list builds its rows from.
	build := loadBuildContext(proj)
	config := readProjectConfig(proj.ID)

	var (
		counts   changeCounts
		stashes  int
		commits  []commitSummary
		upstream remoteSync
		base     *baseJSON
		accent   string
		wg       sync.WaitGroup
	)
	wg.Add(6)
	go func() { defer wg.Done(); counts = readChangeCounts(id.Path) }()
	go func() { defer wg.Done(); stashes = stashCount(id.Path) }()
	go func() { defer wg.Done(); commits = listCommits(id.Path, 0, 1) }()
	go func() { defer wg.Done(); upstream = getRemoteSync(id.Path) }()
	go func() {
		defer wg.Done()
		if ahead, behind, ok := divergenceFrom(id.Path, build.primaryRef); ok {
			base = &baseJSON{Ref: build.primaryRef, syncJSON: syncJSON{Ahead: ahead, Behind: behind}}
		}
	}()
	go func() {
		defer wg.Done()
		// Icon work for the header's project accent; skipped when the
		// color would be painted away anyway.
		if stdoutColor {
			accent = projectColorCode(proj)
		}
	}()
	wg.Wait()

	global := readGlobalConfig()
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
		Shelved:     !id.IsPrimary && !id.IsExternal && build.shelved[id.ID],
		Git: gitStatusJSON{
			Base:         base,
			changeCounts: counts,
			StashCount:   stashes,
		},
		Ports: provisionedPorts(id.Path),
		PortPool: portPoolJSON{
			Enabled:    global.PortPool != nil && *global.PortPool,
			Installed:  portPoolInstalled(),
			Configured: portPoolConfigured(id.Path),
		},
	}
	if upstream.hasUpstream {
		status.Git.Upstream = &syncJSON{Ahead: upstream.ahead, Behind: upstream.behind}
	}
	if len(commits) > 0 {
		status.Git.LastCommit = &commits[0]
	}
	if config != nil {
		status.Scripts = scriptsJSON{Setup: config.Scripts.Setup, Teardown: config.Scripts.Teardown}
	}

	probe := <-probes
	status.PR = probe.card
	if probe.card == nil && probe.reason != "" {
		status.PRUnavailable = probe.reason
	}

	if jsonMode {
		emit(status)
		return 0, nil
	}
	out(statusCard(status, probe, accent))
	return 0, nil
}
