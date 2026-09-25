package main

// sm worktrees list + sm worktrees path.

import (
	"fmt"
	"strings"
	"sync"
)

// Cell colors follow the app's semantic families (emerald=success,
// amber=warning, sky=info); the words alone carry the meaning when
// color is off. Palette-parameterized because the picker renders the
// same cells on stderr.
// The ↑ahead ↓behind cell. Shared with the status card so a table row
// and a card can't describe the same divergence differently. even is
// the label for "no divergence at all".
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

func syncCell(p palette, w worktreeJSON) string {
	if w.Detached {
		return p.yellow("detached")
	}
	if !w.HasUpstream {
		return p.dim("local")
	}
	return divergenceCell(p, w.Ahead, w.Behind, "synced")
}

// primary before external, and never both: the primary checkout isn't
// under the managed base either, and calling it external would only
// confuse. Shared with the status card's header.
func worktreeFlags(isPrimary, isExternal, shelved, autoPull bool) []string {
	var flags []string
	if isPrimary {
		flags = append(flags, "primary")
	} else if isExternal {
		flags = append(flags, "external")
	}
	if shelved {
		flags = append(flags, "shelved")
	}
	if autoPull {
		flags = append(flags, "auto-pull")
	}
	return flags
}

func flagsCell(p palette, w worktreeJSON) string {
	return p.dim(strings.Join(worktreeFlags(w.IsPrimary, w.IsExternal, w.Shelved, w.AutoPull), ", "))
}

func changesCell(p palette, w worktreeJSON) string {
	if w.ChangedCount > 0 {
		return p.yellow(fmt.Sprintf("%d changed", w.ChangedCount))
	}
	return p.dim("clean")
}

func cmdList(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{
			"project": {"p"}, "from": nil,
			// App plumbing: exact addressing by the ids the app holds.
			// --worktree-id narrows the list to that one row (the app's
			// describe after a mutation).
			"project-id": {}, "worktree-id": {},
		},
		// --identities: the cheap listing (listIdentities). --primary-ref
		// adds each project's primary ref to it.
		bools: map[string][]string{"all": {"a"}, "remote": nil, "identities": nil, "primary-ref": nil},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	identitiesOnly := parsed.bools["identities"]
	withPrimaryRef := parsed.bools["primary-ref"]
	if withPrimaryRef && !identitiesOnly {
		return 2, usageErrf("--primary-ref only applies to --identities (full rows always carry primaryRef).")
	}
	if wid := parsed.strings["worktree-id"]; wid != "" {
		target, err := resolveWorktreeByID(ctx, parsed.strings["project-id"], wid)
		if err != nil {
			return exitCodeOf(err), err
		}
		if identitiesOnly {
			return emitIdentities(ctx, []identityGroup{
				identityGroupFor(target.proj, []worktreeIdentity{target.worktree}, withPrimaryRef),
			})
		}
		row := buildWorktree(target.proj, target.worktree, loadBuildContext(target.proj))
		if jsonMode {
			emit([]worktreeJSON{row})
			return 0, nil
		}
		out(renderTable([]string{"NAME", "BRANCH", "SYNC", "CHANGES", ""}, [][]string{{
			row.Name, row.Branch, syncCell(outPalette, row), changesCell(outPalette, row), flagsCell(outPalette, row),
		}}))
		return 0, nil
	}
	// The project's worktrees on the user's other devices, which the
	// running app reads for us (cmd_transfer.go).
	if err := checkDeviceFlags(parsed); err != nil {
		return 2, err
	}
	if parsed.bools["remote"] || parsed.strings["from"] != "" {
		if identitiesOnly {
			return 2, usageErrf("--identities lists this device's worktrees; it doesn't combine with --remote or --from.")
		}
		if parsed.bools["all"] {
			return 2, usageErrf("--remote lists one project's worktrees. Name it with -p, or run from inside it.")
		}
		proj, err := resolveProject(ctx, parsed.strings["project"])
		if err != nil {
			return exitCodeOf(err), err
		}
		return listRemoteWorktrees(proj, parsed.strings["from"])
	}

	if len(ctx.projects) == 0 && parsed.strings["project-id"] == "" {
		return 1, errf("No projects are registered yet. Add a repo in the Shigoto no Mori app first.")
	}

	scope := ctx.projects
	switch {
	case parsed.strings["project-id"] != "":
		proj, err := resolveProjectByID(ctx, parsed.strings["project-id"])
		if err != nil {
			return exitCodeOf(err), err
		}
		scope = []project{proj}
	case !parsed.bools["all"] && (parsed.strings["project"] != "" || ctx.current != nil):
		proj, err := resolveProject(ctx, parsed.strings["project"])
		if err != nil {
			return exitCodeOf(err), err
		}
		scope = []project{proj}
	}

	if identitiesOnly {
		return listIdentities(ctx, scope, withPrimaryRef)
	}

	// Accent colors need per-project git+icon work; overlap it with
	// the worktree listing fan-out. Skipped when the colors would be
	// painted away (piped stdout, --json, NO_COLOR) or the PROJECT
	// column won't render (single-project scope).
	accentsReady := make(chan struct{})
	if !jsonMode && stdoutColor && len(scope) > 1 {
		go func() {
			prefetchProjectColors(scope)
			close(accentsReady)
		}()
	} else {
		close(accentsReady)
	}

	type projectResult struct {
		proj      project
		worktrees []worktreeJSON
		err       error
	}
	results := make([]projectResult, len(scope))
	var wg sync.WaitGroup
	for i, proj := range scope {
		wg.Go(func() {
			worktrees, err := listWorktrees(proj)
			results[i] = projectResult{proj: proj, worktrees: worktrees, err: err}
		})
	}
	wg.Wait()

	// results is indexed by scope position, so collected keeps scope
	// order without any re-sort.
	var collected []projectResult
	for _, r := range results {
		if r.err != nil {
			note(fmt.Sprintf("warning: skipping %s: %s", r.proj.Name, r.err))
			continue
		}
		collected = append(collected, r)
	}

	if jsonMode {
		flat := []worktreeJSON{}
		for _, r := range collected {
			flat = append(flat, r.worktrees...)
		}
		emit(flat)
		return 0, nil
	}

	multi := len(collected) > 1
	// Only block on the accent fan-out when its result will actually
	// paint something, since multi can come up false (errors, empty
	// projects) even though the prefetch was started.
	if multi && stdoutColor {
		<-accentsReady
	}
	currentID := ""
	if ctx.current != nil {
		currentID = ctx.current.worktree.ID
	}
	header := []string{"", "NAME", "BRANCH", "SYNC", "CHANGES", ""}
	if multi {
		header = []string{"", "PROJECT", "NAME", "BRANCH", "SYNC", "CHANGES", ""}
	}
	var rows [][]string
	for _, r := range collected {
		for _, w := range r.worktrees {
			marker := ""
			if w.ID == currentID {
				marker = cyanOut("@")
			}
			row := []string{
				marker, w.Name, w.Branch,
				syncCell(outPalette, w), changesCell(outPalette, w), flagsCell(outPalette, w),
			}
			if multi {
				projectCell := r.proj.Name
				if stdoutColor {
					projectCell = codeOut(projectCell, projectColorCode(r.proj))
				}
				row = append([]string{marker, projectCell}, row[1:]...)
			}
			rows = append(rows, row)
		}
	}
	if len(rows) == 0 {
		note("No worktrees found.")
		return 0, nil
	}
	out(renderTable(header, rows))
	return 0, nil
}

// One `--identities` document entry: a worktree's identity plus its
// registry marks, and with --primary-ref the project's primary ref.
// No per-row git probes go into it, which is the point: the app polls
// this where it needs to know which worktrees exist, and the full row
// only where it shows sync and change state.
type worktreeIdentityJSON struct {
	ID            string `json:"id"`
	ProjectID     string `json:"projectId"`
	Name          string `json:"name"`
	Branch        string `json:"branch"`
	Path          string `json:"path"`
	IsPrimary     bool   `json:"isPrimary"`
	IsExternal    bool   `json:"isExternal"`
	Detached      bool   `json:"detached"`
	Shelved       bool   `json:"shelved"`
	AutoPull      bool   `json:"autoPull"`
	PrimaryRef    string `json:"primaryRef,omitempty"`
	PrimaryBranch string `json:"primaryBranch,omitempty"`
}

// One project's identities, primary first, with the primary ref when
// it was asked for (resolved once for the whole project).
type identityGroup struct {
	proj                      project
	identities                []worktreeIdentity
	primaryRef, primaryBranch string
}

func identityGroupFor(proj project, identities []worktreeIdentity, withPrimaryRef bool) identityGroup {
	group := identityGroup{
		proj:       proj,
		identities: partitionStable(identities, func(id worktreeIdentity) bool { return id.IsPrimary }),
	}
	if withPrimaryRef {
		remotes, primaryRef, _ := loadPrimaryRef(proj)
		group.primaryRef, group.primaryBranch = primaryRef, primaryBranchOf(primaryRef, remotes)
	}
	return group
}

// sm worktrees list --identities: `git worktree list` (memoized) per
// project and one registry read for the marks, nothing per row. Same
// scope, order and skip-with-warning as the full list.
func listIdentities(ctx cliContext, scope []project, withPrimaryRef bool) (int, error) {
	type result struct {
		group identityGroup
		err   error
	}
	results := make([]result, len(scope))
	var wg sync.WaitGroup
	for i, proj := range scope {
		wg.Go(func() {
			identities, err := listWorktreeIdentities(proj)
			if err != nil {
				results[i] = result{err: err}
				return
			}
			results[i] = result{group: identityGroupFor(proj, identities, withPrimaryRef)}
		})
	}
	wg.Wait()
	var groups []identityGroup
	for i, r := range results {
		if r.err != nil {
			note(fmt.Sprintf("warning: skipping %s: %s", scope[i].Name, r.err))
			continue
		}
		groups = append(groups, r.group)
	}
	return emitIdentities(ctx, groups)
}

// The --identities document (one JSON array across every group), or a
// NAME/BRANCH/flags table.
func emitIdentities(ctx cliContext, groups []identityGroup) (int, error) {
	sets := readWorktreeMarkSets()
	marks := buildContext{shelved: sets[shelvedKey], autoPull: sets[autoPullKey]}
	flat := []worktreeIdentityJSON{}
	for _, group := range groups {
		for _, id := range group.identities {
			flat = append(flat, worktreeIdentityJSON{
				ID: id.ID, ProjectID: id.ProjectID, Name: id.Name, Branch: id.Branch, Path: id.Path,
				IsPrimary: id.IsPrimary, IsExternal: id.IsExternal, Detached: id.Detached,
				Shelved:       shelvedFlag(id, marks),
				AutoPull:      marks.autoPull[id.ID],
				PrimaryRef:    group.primaryRef,
				PrimaryBranch: group.primaryBranch,
			})
		}
	}
	if jsonMode {
		emit(flat)
		return 0, nil
	}
	if len(flat) == 0 {
		note("No worktrees found.")
		return 0, nil
	}
	currentID := ""
	if ctx.current != nil {
		currentID = ctx.current.worktree.ID
	}
	names := map[string]string{}
	for _, group := range groups {
		names[group.proj.ID] = group.proj.Name
	}
	multi := len(groups) > 1
	header := []string{"", "NAME", "BRANCH", ""}
	if multi {
		header = []string{"", "PROJECT", "NAME", "BRANCH", ""}
	}
	rows := make([][]string, len(flat))
	for i, w := range flat {
		marker := ""
		if w.ID == currentID {
			marker = cyanOut("@")
		}
		flags := dimOut(strings.Join(worktreeFlags(w.IsPrimary, w.IsExternal, w.Shelved, w.AutoPull), ", "))
		rows[i] = []string{marker, w.Name, w.Branch, flags}
		if multi {
			rows[i] = []string{marker, names[w.ProjectID], w.Name, w.Branch, flags}
		}
	}
	out(renderTable(header, rows))
	return 0, nil
}

func cmdPath(ctx cliContext, args []string) (int, error) {
	_, target, err := parseWorktreeArgs(ctx, args, worktreeTargetSpec(), true)
	if err != nil {
		return exitCodeOf(err), err
	}
	emitOrOut(map[string]any{
		"id":          target.worktree.ID,
		"name":        target.worktree.Name,
		"branch":      target.worktree.Branch,
		"path":        target.worktree.Path,
		"projectName": target.proj.Name,
		"projectId":   target.proj.ID,
		"isPrimary":   target.worktree.IsPrimary,
	}, target.worktree.Path)
	return 0, nil
}
