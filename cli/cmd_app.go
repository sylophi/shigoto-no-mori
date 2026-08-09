package main

// sgm app -- open (or focus) the Shigoto no Mori app. Addressed by
// bundle id so a renamed or moved bundle still resolves. The dev CLI
// refuses: the dev app isn't installed, it runs from a checkout.

import (
	"os/exec"
	"runtime"
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
