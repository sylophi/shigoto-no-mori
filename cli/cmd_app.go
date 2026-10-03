package main

// sm app opens (or focuses) the Shigoto no Mori app. Addressed by
// bundle id so a renamed or moved bundle still resolves. The dev CLI
// refuses: the dev app isn't installed, it runs from a checkout.

import (
	"os/exec"
)

// Launch (or activate) the installed app by bundle id, so a renamed or
// moved bundle still resolves. (The update installer relaunches by
// path instead. See cmdUpdateFinishInstall.) `open` hands a cold
// launch our whole environment. The app rebuilds its own at startup
// (app/main/core/shellEnv.ts), and the shell wrapper's cd-directive
// file stays out of it here like it does for every launcher.
func openAppBundle() error {
	cmd := exec.Command("open", "-b", appBundleID)
	cmd.Env = envWithoutCdFile()
	if err := cmd.Run(); err != nil {
		return errf("Couldn't open Shigoto no Mori. Is the app installed?")
	}
	return nil
}

func cmdApp(_ cliContext, args []string) (int, error) {
	if len(args) > 0 {
		return 2, usageErrf("app takes no arguments.")
	}
	if flavor != "prod" {
		return 1, errf("This is the dev CLI; the dev app isn't installed. Run `pnpm dev` in a checkout instead.")
	}
	if err := openAppBundle(); err != nil {
		return 1, err
	}
	emitOrOut(map[string]any{"ok": true}, "opened Shigoto no Mori")
	return 0, nil
}
