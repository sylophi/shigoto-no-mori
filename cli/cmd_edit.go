package main

// sm edit <file> opens a worktree's file in the editor config.json's
// editor names (a catalog id from the tools marked editor), or with
// macOS's default app for it while that's unset or no longer
// installed. A relative path reads from cwd when the worktree is cwd's,
// and from the worktree's root when it's named.
//
// The app opens a file through here, by exact address: `sm --json edit
// --project-id P --worktree-id W -- <path>`, the path relative to the
// worktree's root. The answer is {ok, path}.

import (
	"cmp"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// The editor key's values.
var editorIDs = func() []string {
	var ids []string
	for _, a := range launcherCatalog {
		if a.editor {
			ids = append(ids, a.id)
		}
	}
	slices.Sort(ids)
	return ids
}()

func cmdEdit(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	file := parsed.positional(0)
	if file == "" {
		return 2, usageErrf("Pass a file to edit: %s edit <file> [<name>].", binaryName)
	}
	target, fromCwd, err := commandTarget(ctx, parsed, "edit <file>")
	if err != nil {
		return exitCodeOf(err), err
	}
	if !filepath.IsAbs(file) {
		base := target.worktree.Path
		if fromCwd {
			if base, err = os.Getwd(); err != nil {
				return 1, err
			}
		}
		file = filepath.Join(base, file)
	}
	if _, err := os.Stat(file); err != nil {
		return 1, codedErrf("missing-file", "No file at %s.", file)
	}
	if err := editFile(file, target.worktree.Path); err != nil {
		return 1, errf("Couldn't open %s: %v", filepath.Base(file), err)
	}
	emitOrOut(map[string]any{"ok": true, "path": file}, "opened "+file)
	return 0, nil
}

func chosenEditor() (launcherApp, bool) {
	id := readGlobalConfigHints().Editor
	for _, a := range launcherCatalog {
		if a.id == id && launcherAvailable(a) {
			return a, true
		}
	}
	return launcherApp{}, false
}

func editFile(file, worktreePath string) error {
	a, ok := chosenEditor()
	switch {
	case !ok:
		if out, err := exec.Command("open", file).CombinedOutput(); err != nil {
			return errf("%s", cmp.Or(strings.TrimSpace(string(out)), err.Error()))
		}
		return nil
	case a.inTerminal != "":
		program := strings.Fields(a.inTerminal)[0]
		return launchInTerminal(program+" "+shellQuote(file), worktreePath)
	case a.cli != "":
		// The worktree goes along, so the file opens in the window
		// that has it (or a new one for it) rather than the last one
		// used.
		if _, err := exec.LookPath(a.cli); err == nil {
			if exec.Command(a.cli, worktreePath, file).Run() == nil {
				return nil
			}
		}
	}
	for _, name := range a.bundleNames {
		if bundle := bundlePathFor(name); bundle != "" {
			return openWithBundle(bundle, file)
		}
	}
	return errf("No installed app found for %s.", a.label)
}
