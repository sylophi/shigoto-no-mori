package main

// sm app -- open (or focus) the Shigoto no Mori app. Addressed by
// bundle id so a renamed or moved bundle still resolves. The dev CLI
// refuses: the dev app isn't installed, it runs from a checkout.

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const appBundleID = "com.sylophi.shigomori"

func cmdApp(_ cliContext, args []string) (int, error) {
	if len(args) > 0 {
		return 2, usageErrf("app takes no arguments.")
	}
	if runtime.GOOS != "darwin" {
		return 1, errf("Opening the app is only supported on macOS.")
	}
	if flavor != "prod" {
		return 1, errf("This is the dev CLI; the dev app isn't installed. Run `pnpm dev` in a checkout instead.")
	}
	if err := exec.Command("open", "-b", appBundleID).Run(); err != nil {
		return 1, errf("Couldn't open Shigoto no Mori -- is the app installed?")
	}
	if jsonMode {
		emit(map[string]any{"ok": true})
	} else {
		out("opened Shigoto no Mori")
	}
	return 0, nil
}

// sm config -- open the global config file. $VISUAL/$EDITOR in an
// interactive terminal, the OS opener otherwise; --json (and
// editor-less non-darwin) just reports the path. Per-project config
// lives under `sm projects config`.
func cmdConfigOpen(_ cliContext, args []string) (int, error) {
	if len(args) > 0 {
		return 2, usageErrf(
			"config takes no arguments. Per-project config is `%s projects config`.", binaryName)
	}
	path := filepath.Join(shigomoriRoot(), "config.json")
	if _, err := os.Stat(path); err != nil {
		// Give the editor a real file so a save round-trips.
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if writeErr := os.WriteFile(path, []byte("{}\n"), 0o644); writeErr != nil {
			return 1, errf("Couldn't create %s: %v", path, writeErr)
		}
	}
	if jsonMode {
		emit(map[string]any{"path": path})
		return 0, nil
	}
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor != "" && interactiveStdio() {
		quoted := "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
		cmd := exec.Command("/bin/sh", "-c", editor+" "+quoted)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return 1, errf("%s failed: %v", editor, err)
		}
		return 0, nil
	}
	if runtime.GOOS == "darwin" {
		if err := exec.Command("open", path).Run(); err != nil {
			return 1, errf("Couldn't open %s: %v", path, err)
		}
		out("opened " + path)
		return 0, nil
	}
	out(path)
	return 0, nil
}
