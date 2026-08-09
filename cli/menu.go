package main

// The arrow-key selection menu behind every picker: highlight bar,
// up/down or j/k to move, enter to select, q/esc/ctrl-c to cancel,
// 1-9 jumps. Draws on stderr and erases itself on exit, so command
// output (stdout) is all that remains. When raw mode can't be enabled
// (exotic terminal), falls back to the old numbered prompt, which also
// keeps `printf '2\n' | sgm ...`-style expect scripts meaningful.

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Returns the selected index into rows. names feed the fallback
// prompt's type-a-name matching.
func menuSelect(title string, rows []string, names []string) (int, error) {
	if len(rows) == 0 {
		return -1, errf("Nothing to select from.")
	}
	old, err := getTermios(os.Stdin)
	if err != nil {
		return menuSelectNumbered(title, rows, names)
	}
	raw := old
	raw.lflag &^= flagICANON | flagECHO | flagISIG
	raw.cc[ccVMIN] = 1
	raw.cc[ccVTIME] = 0
	if err := setTermios(os.Stdin, raw); err != nil {
		return menuSelectNumbered(title, rows, names)
	}
	defer func() { _ = setTermios(os.Stdin, old) }()

	stderr := os.Stderr
	fmt.Fprint(stderr, "\x1b[?25l")       // hide cursor
	defer fmt.Fprint(stderr, "\x1b[?25h") // show cursor

	hint := dimErr("↑/↓ move, enter select, q cancel")
	height := len(rows) + 2 // title + rows + hint, minus the first line
	selected := 0
	draw := func(redraw bool) {
		if redraw {
			fmt.Fprintf(stderr, "\x1b[%dA", height+1)
		}
		fmt.Fprint(stderr, "\x1b[2K"+title+"\n")
		for i, row := range rows {
			marker := "  "
			if i == selected {
				marker = cyanErr("❯") + " "
			}
			fmt.Fprint(stderr, "\x1b[2K"+marker+row+"\n")
		}
		fmt.Fprint(stderr, "\x1b[2K"+hint+"\n")
	}
	erase := func() {
		fmt.Fprintf(stderr, "\x1b[%dA", height+1)
		for i := 0; i <= height; i++ {
			fmt.Fprint(stderr, "\x1b[2K\n")
		}
		fmt.Fprintf(stderr, "\x1b[%dA", height+1)
	}

	draw(false)
	buf := make([]byte, 3)
	for {
		n, err := os.Stdin.Read(buf)
		if err != nil || n == 0 {
			erase()
			return -1, errf("Cancelled.")
		}
		// Arrow keys arrive as ESC [ A/B; a lone ESC cancels. A pty may
		// deliver the sequence byte by byte, so give continuation bytes
		// a moment to arrive before reading ESC as cancel.
		if buf[0] == 0x1b {
			for n < 3 {
				if n >= 2 && buf[1] != '[' {
					break
				}
				if !waitReadable(os.Stdin, 50) {
					break
				}
				m, _ := os.Stdin.Read(buf[n:3])
				if m <= 0 {
					break
				}
				n += m
			}
		}
		key := ""
		switch {
		case n >= 3 && buf[0] == 0x1b && buf[1] == '[':
			switch buf[2] {
			case 'A':
				key = "up"
			case 'B':
				key = "down"
			}
		case buf[0] == 0x1b, buf[0] == 'q', buf[0] == 0x03, buf[0] == 0x04:
			erase()
			return -1, errf("Cancelled.")
		case buf[0] == '\r', buf[0] == '\n':
			erase()
			return selected, nil
		case buf[0] == 'k':
			key = "up"
		case buf[0] == 'j':
			key = "down"
		case buf[0] >= '1' && buf[0] <= '9':
			if jump := int(buf[0] - '1'); jump < len(rows) {
				selected = jump
				draw(true)
			}
			continue
		default:
			continue
		}
		switch key {
		case "up":
			selected = (selected - 1 + len(rows)) % len(rows)
		case "down":
			selected = (selected + 1) % len(rows)
		default:
			continue
		}
		draw(true)
	}
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
