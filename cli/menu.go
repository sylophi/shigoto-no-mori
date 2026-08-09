package main

// The selection menu behind every picker, rendered by charmbracelet's
// huh: arrow keys or j/k, enter to select, esc/ctrl-c to cancel, with
// scrolling on long lists. Output goes to stderr so command results
// (stdout) stay clean -- `cd "$(sm path)"` opens the menu and still
// cd's. Option labels are plain text (huh owns the highlight styling).
// Terminals huh can't drive fall back to a numbered prompt, which also
// keeps `printf '2\n' | ...`-style scripting meaningful.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/charmbracelet/huh"
)

// Returns the selected index into rows; initial is the row highlighted
// first. names feed the fallback prompt's type-a-name matching.
func menuSelect(title string, rows []string, names []string, initial int) (int, error) {
	if len(rows) == 0 {
		return -1, errf("Nothing to select from.")
	}
	options := make([]huh.Option[int], len(rows))
	for i, row := range rows {
		options[i] = huh.NewOption(row, i)
	}
	selected := 0
	if initial >= 0 && initial < len(rows) {
		selected = initial
	}
	sel := huh.NewSelect[int]().
		Title(title).
		Options(options...).
		Value(&selected)
	form := huh.NewForm(huh.NewGroup(sel)).
		WithOutput(os.Stderr).
		WithTheme(huh.ThemeBase()).
		WithShowHelp(true)
	if err := form.Run(); err != nil {
		if errors.Is(err, huh.ErrUserAborted) {
			return -1, errf("Cancelled.")
		}
		return menuSelectNumbered(title, rows, names)
	}
	return selected, nil
}

func menuSelectNumbered(title string, rows []string, names []string) (int, error) {
	note(title)
	note("")
	for i, row := range rows {
		note("  " + dimErr(strconv.Itoa(i+1)+".") + " " + row)
	}
	note("")
	reader := bufio.NewReader(os.Stdin)
	for {
		fmt.Fprintf(os.Stderr, "Select [1-%d]: ", len(rows))
		input, err := reader.ReadString('\n')
		if err != nil {
			note("")
			return -1, errf("Cancelled.")
		}
		answer := strings.TrimSpace(input)
		if answer == "" || strings.EqualFold(answer, "q") {
			return -1, errf("Cancelled.")
		}
		if n, convErr := strconv.Atoi(answer); convErr == nil && n >= 1 && n <= len(rows) {
			return n - 1, nil
		}
		for i, name := range names {
			if strings.EqualFold(name, answer) {
				return i, nil
			}
		}
		note(fmt.Sprintf("Enter a number between 1 and %d, a name, or blank to cancel.", len(rows)))
	}
}
