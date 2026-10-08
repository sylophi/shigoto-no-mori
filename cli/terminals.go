package main

// Terminal tools (catalog entries with inTerminal) run in the terminal
// the user picked: config.json's terminal key, a catalog id from
// terminalScripts. Terminal stands in when it's unset or the pick is no
// longer installed. Each terminal is driven over AppleScript, which
// types the command into a new window's own shell (a new workspace in
// cmux), so the window is one the user could have opened: their shell
// config and history, and a prompt left behind when the tool exits.
// cmux's control socket would do too, but by default it only takes
// processes started inside cmux.

import (
	"cmp"
	"maps"
	"os/exec"
	"slices"
	"strings"
)

const defaultTerminal = "terminal"

// The terminal key's values.
var terminalIDs = slices.Sorted(maps.Keys(terminalScripts))

// Each terminal's AppleScript, taking the line to type as its argument.
var terminalScripts = map[string]string{
	"terminal": terminalScript("Terminal",
		`do script cmd`,
		`do script cmd in window 1`),
	"iterm": terminalScript("iTerm",
		`tell current session of (create window with default profile) to write text cmd`,
		`tell current session of current window to write text cmd`),
	"ghostty": terminalScript("Ghostty",
		`set cfg to new surface configuration
			set initial input of cfg to cmd & linefeed
			new window with configuration cfg`,
		`set t to focused terminal of selected tab of front window
			input text cmd to t
			send key "enter" to t`),
	// A workspace is cmux's unit, so always a new one, launching or not:
	// a cmux that just launched may have restored the user's workspaces.
	"cmux": `on run argv
	set cmd to item 1 of argv
	tell application "cmux"
		set w to new tab
		select tab w
		input text (cmd & linefeed) to focused terminal of w
		activate
	end tell
end run`,
}

// A terminal that isn't running opens a window of its own as it
// launches, so the command waits up to 5s for that window and goes
// into it rather than a second one.
func terminalScript(app, intoNewWindow, intoLaunchWindow string) string {
	return `on run argv
	set cmd to item 1 of argv
	set wasRunning to application "` + app + `" is running
	tell application "` + app + `"
		if not wasRunning then
			repeat 100 times
				if (count of windows) > 0 then exit repeat
				delay 0.05
			end repeat
		end if
		if not wasRunning and (count of windows) > 0 then
			` + intoLaunchWindow + `
		else
			` + intoNewWindow + `
		end if
		activate
	end tell
end run`
}

func chosenTerminal() string {
	id := readGlobalConfigHints().Terminal
	for _, a := range launcherCatalog {
		if a.id == id && terminalScripts[id] != "" && launcherAvailable(a) {
			return id
		}
	}
	return defaultTerminal
}

func launchInTerminal(command, worktreePath string) error {
	// Two lines, so the window or workspace is titled by the tool's
	// command rather than the cd.
	line := "cd " + shellQuote(worktreePath) + "\n" + command
	out, err := exec.Command("osascript", "-e", terminalScripts[chosenTerminal()], line).CombinedOutput()
	if err != nil {
		return errf("Couldn't open the terminal: %s", cmp.Or(strings.TrimSpace(string(out)), err.Error()))
	}
	return nil
}
