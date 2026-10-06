package main

// sm describe: a worktree's title and description, the name and
// summary its work goes by before there is a pull request to carry
// them. An agent sets them as soon as the work has a purpose (when it
// renames the branch) and keeps them current as the work moves. They
// live in the worktree's data file (projects/<pid>/worktrees/<id>.json),
// so a move re-keys them and a removal drops them with the rest, and
// `list` rows carry them for the sidebar and the worktree page.
//
// Once the branch has a pull request, the PR's title and body are the
// worktree's, and describe refuses a change: it belongs on the PR (gh
// pr edit). A lookup that can't be made (no gh, no remote, gh failing)
// doesn't block the write, since the app can't find the PR then
// either and shows the local text.

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// GitHub's own limits for a PR title and body, so a description the
// worktree outgrows still fits the PR it becomes.
const (
	maxTitleRunes       = 256
	maxDescriptionRunes = 65536
)

// DescribedAt (unix ms) is when either was last set: a mirror's two
// sides each take describes, and the newer pair is the one both keep
// (the app's mirror follower).
type worktreeDescription struct {
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	DescribedAt int64  `json:"describedAt,omitempty"`
}

// Whether the worktree keeps a data file (the app's hasWorktreeData):
// the primary checkout reads as external but is still ours to
// annotate, while a genuinely external checkout keeps nothing.
func hasWorktreeData(id worktreeIdentity) bool {
	return !id.IsExternal || id.IsPrimary
}

// The title and description in a worktree's data file, empty when it
// has none or the file can't be read: the row is a display, and a
// broken data file shouldn't keep the worktree off the list.
func readWorktreeDescription(projectID, worktreeID string) worktreeDescription {
	desc, _ := readJSONFile[worktreeDescription](worktreeDataPath(projectID, worktreeID))
	return desc
}

// Updates the three keys in the data file from what they hold under
// the lock, so a write that landed since the caller last looked (the
// app's mirror follower, another describe) isn't undone. An empty value
// clears its key, and every other key (the app's custom ports) stays
// as it is. Answers what it wrote.
func updateWorktreeDescription(projectID, worktreeID string, update func(worktreeDescription) worktreeDescription) (worktreeDescription, error) {
	path := worktreeDataPath(projectID, worktreeID)
	var desc worktreeDescription
	err := withFileLock(path, func() error {
		all, err := readJSONObject(path)
		if err != nil {
			return err
		}
		var current worktreeDescription
		if err := decodeKey(path, "title", all["title"], &current.Title); err != nil {
			return err
		}
		if err := decodeKey(path, "description", all["description"], &current.Description); err != nil {
			return err
		}
		if err := decodeKey(path, "describedAt", all["describedAt"], &current.DescribedAt); err != nil {
			return err
		}
		desc = update(current)
		for key, value := range map[string]any{"title": desc.Title, "description": desc.Description, "describedAt": desc.DescribedAt} {
			if value == "" || value == int64(0) {
				delete(all, key)
				continue
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				return err
			}
			all[key] = encoded
		}
		return writeJSONObject(path, all)
	})
	return desc, err
}

// sm describe [<name>] [-t <title>] [-d <description> | --description-file <path|->]
func cmdDescribe(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.strings["title"] = []string{"t"}
	spec.strings["description"] = []string{"d"}
	spec.strings["description-file"] = []string{}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	if len(parsed.positionals) > 1 {
		return 2, usageErrf("Usage: %s describe [<name>] [-t <title>] [-d <description> | --description-file <path|->]", binaryName)
	}
	title, setTitle := parsed.strings["title"]
	description, setDescription := parsed.strings["description"]
	if file, ok := parsed.strings["description-file"]; ok {
		if setDescription {
			return 2, usageErrf("Give the description with -d or --description-file, not both.")
		}
		if description, err = readDescriptionFile(file); err != nil {
			return 1, err
		}
		setDescription = true
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree
	if !hasWorktreeData(id) {
		return 1, errf("External worktrees have no data file to hold a title. Adopt it first (%s adopt).", binaryName)
	}
	if !setTitle && !setDescription {
		desc := readWorktreeDescription(proj.ID, id.ID)
		pr := pullRequestOwningDescription(proj, id)
		if jsonMode {
			emit(map[string]any{"ok": true, "title": desc.Title, "description": desc.Description, "pullRequest": pr})
			return 0, nil
		}
		if pr != nil {
			note(dimErr(fmt.Sprintf("PR #%d gives this worktree its title and description: %s", pr.Number, pr.URL)))
		}
		if desc.Title == "" && desc.Description == "" {
			out(id.Name + " has no title or description")
			return 0, nil
		}
		out(cmp.Or(desc.Title, "(no title)"))
		if desc.Description != "" {
			out("")
			out(desc.Description)
		}
		return 0, nil
	}

	if setTitle {
		title = strings.TrimSpace(title)
		if strings.ContainsAny(title, "\r\n") {
			return 2, usageErrf("A title is one line.")
		}
		if utf8.RuneCountInString(title) > maxTitleRunes {
			return 2, usageErrf("A title is at most %d characters.", maxTitleRunes)
		}
	}
	if setDescription {
		description = strings.TrimSpace(description)
		if utf8.RuneCountInString(description) > maxDescriptionRunes {
			return 2, usageErrf("A description is at most %d characters.", maxDescriptionRunes)
		}
	}
	// Last, after the flags are known good: it asks GitHub.
	if pr := pullRequestOwningDescription(proj, id); pr != nil {
		return 1, errf("%s has PR #%d, which gives it its title and description. Edit the PR instead: gh pr edit %d --title … --body …",
			id.Name, pr.Number, pr.Number)
	}
	desc, err := updateWorktreeDescription(proj.ID, id.ID, func(desc worktreeDescription) worktreeDescription {
		if setTitle {
			desc.Title = title
		}
		if setDescription {
			desc.Description = description
		}
		desc.DescribedAt = time.Now().UnixMilli()
		return desc
	})
	if err != nil {
		return 1, err
	}
	if jsonMode {
		row := buildWorktree(proj, id, loadBuildContext(proj))
		emit(map[string]any{"ok": true, "worktree": row})
		return 0, nil
	}
	out(greenOut("described " + id.Name + ": " + cmp.Or(desc.Title, "(no title)")))
	return 0, nil
}

// The listing's and the picker's last column: the title `describe`
// set, cut to fit a terminal line. Only the local one: the tables make
// no gh call, so a PR that took the title over isn't seen there.
func titleCell(w worktreeJSON) string {
	return truncateRunes(w.Title, 50)
}

// "-" reads stdin, so a heredoc or a pipe can carry a long description.
func readDescriptionFile(path string) (string, error) {
	var (
		raw []byte
		err error
	)
	if path == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return "", errf("Couldn't read the description: %v", err)
	}
	return string(raw), nil
}

// The PR that owns the worktree's title and description, nil when it
// has none or none can be looked up (the app's worktreeTitle rule): the status card's bounded probe,
// since describe runs in an agent's loop and must not hang on gh.
func pullRequestOwningDescription(proj project, id worktreeIdentity) *prSummary {
	if id.Detached || id.Branch == unknownBranch {
		return nil
	}
	// The primary branch is never a PR's own: one headed there comes
	// from a fork's branch of the same name.
	remotes, primaryRef, _ := loadPrimaryRef(proj)
	if len(remotes) == 0 || id.Branch == primaryBranchOf(primaryRef, remotes) {
		return nil
	}
	probe := probePullRequest(proj.Path, id.Branch)
	if probe.reason != "" {
		note(dimErr("Couldn't check for a pull request (" + probe.reason + ")."))
	}
	if probe.card == nil {
		return nil
	}
	return &probe.card.prSummary
}
