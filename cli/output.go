package main

// Output contract (mirrors the app-side conventions): command results
// on stdout, progress and streamed script output on stderr, so
// `cd $(sm path fox)` and agent pipelines stay clean. In --json mode
// stdout carries only JSON: one document for list/path/rm, NDJSON
// events for create's streamed progress.

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/muesli/termenv"
)

var (
	jsonMode    bool
	verboseMode bool
)

// ANSI is decoration only -- meaning always lives in the text itself,
// so pipes, agents, and --json consumers lose nothing. Enabled per
// stream, only when it's a terminal, NO_COLOR is unset, and TERM isn't
// dumb (the conventions gh/cargo follow).
var (
	stdoutColor bool
	stderrColor bool
)

func initColor() {
	if jsonMode || os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return
	}
	stdoutColor = isTerminal(os.Stdout)
	stderrColor = isTerminal(os.Stderr)
}

// The exact reset paint emits is load-bearing: selectedRow (menu.go)
// rewrites it to keep the selection bar alive across painted cells.
const ansiReset = "\x1b[0m"

func paint(s, code string, enabled bool) string {
	if !enabled || s == "" || code == "" {
		return s
	}
	return "\x1b[" + code + "m" + s + ansiReset
}

func boldOut(s string) string   { return paint(s, "1", stdoutColor) }
func cyanOut(s string) string   { return paint(s, "36", stdoutColor) }
func greenOut(s string) string  { return paint(s, "32", stdoutColor) }
func yellowOut(s string) string { return paint(s, "33", stdoutColor) }
func dimOut(s string) string    { return paint(s, "2", stdoutColor) }
func redOut(s string) string    { return paint(s, "31", stdoutColor) }
func boldErr(s string) string   { return paint(s, "1", stderrColor) }
func cyanErr(s string) string   { return paint(s, "36", stderrColor) }
func greenErr(s string) string  { return paint(s, "32", stderrColor) }
func yellowErr(s string) string { return paint(s, "33", stderrColor) }
func dimErr(s string) string    { return paint(s, "2", stderrColor) }
func redErr(s string) string    { return paint(s, "31", stderrColor) }

// Arbitrary SGR codes (the per-project accent colors from hue.go);
// an empty code means "no accent" and leaves the text untouched.
func codeOut(s, code string) string { return paint(s, code, stdoutColor) }
func codeErr(s, code string) string { return paint(s, code, stderrColor) }

// Whether the terminal background is dark: COLORFGBG ("fg;bg", set by
// konsole/rxvt and friends) when present, else assume dark, the more
// common terminal theme. Deliberately NOT an OSC 11 query -- that
// requires a competing reader on the tty, which eats type-ahead
// keystrokes and stalls for seconds on terminals that never answer.
var darkBackground = sync.OnceValue(func() bool {
	parts := strings.Split(os.Getenv("COLORFGBG"), ";")
	if len(parts) >= 2 {
		if bg, err := strconv.Atoi(parts[len(parts)-1]); err == nil {
			return bg <= 6 || bg == 8
		}
	}
	return true
})

// Terminal color depth from the environment (COLORTERM/TERM/NO_COLOR),
// for rendering arbitrary RGB accents at the best supported depth.
var colorProfile = sync.OnceValue(termenv.EnvColorProfile)

// Cells built for one stream keep their colors right on the other too:
// a palette bundles the painters so shared renderers (worktree rows in
// `list` on stdout, the picker on stderr) stay in one place.
type palette struct {
	cyan, green, yellow, dim func(string) string
}

var (
	outPalette = palette{cyanOut, greenOut, yellowOut, dimOut}
	errPalette = palette{cyanErr, greenErr, yellowErr, dimErr}
)

var ansiRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

func visibleWidth(s string) int {
	return len([]rune(stripANSI(s)))
}

// Usage / operational errors with a chosen exit code. Anything else
// that escapes a command is an environment failure and exits 1.
// kind, when set, is a stable machine-readable code carried in the
// --json error document so the app maps failures without matching
// prose (see errorKindOf and main/ipc's cliFailureError).
type cliError struct {
	msg  string
	code int
	kind string
}

func (e *cliError) Error() string { return e.msg }

func usageErrf(format string, args ...any) error {
	return &cliError{msg: fmt.Sprintf(format, args...), code: 2}
}

func errf(format string, args ...any) error {
	return &cliError{msg: fmt.Sprintf(format, args...), code: 1}
}

func codedErrf(kind, format string, args ...any) error {
	return &cliError{msg: fmt.Sprintf(format, args...), code: 1, kind: kind}
}

func errorKindOf(err error) string {
	if cliErr, ok := err.(*cliError); ok {
		return cliErr.kind
	}
	return ""
}

func out(line string) { fmt.Fprintln(os.Stdout, line) }

func emit(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: json encode: %v\n", binaryName, err)
		return
	}
	os.Stdout.Write(append(data, '\n'))
}

func note(line string) { fmt.Fprintln(os.Stderr, line) }

func vlog(format string, args ...any) {
	if verboseMode {
		fmt.Fprintf(os.Stderr, format+"\n", args...)
	}
}

// alignRows pads every cell to its column's widest entry and joins each
// row into one line. visibleWidth: cells may carry ANSI, which must not
// skew column alignment. Shared by renderTable and the picker rows.
func alignRows(rows [][]string) []string {
	if len(rows) == 0 {
		return nil
	}
	cellWidths := make([][]int, len(rows))
	widths := make([]int, len(rows[0]))
	for r, row := range rows {
		cellWidths[r] = make([]int, len(row))
		for i, cell := range row {
			n := visibleWidth(cell)
			cellWidths[r][i] = n
			if n > widths[i] {
				widths[i] = n
			}
		}
	}
	lines := make([]string, len(rows))
	for r, row := range rows {
		var line strings.Builder
		for i, cell := range row {
			line.WriteString(cell)
			line.WriteString(strings.Repeat(" ", widths[i]-cellWidths[r][i]+2))
		}
		lines[r] = strings.TrimRight(line.String(), " ")
	}
	return lines
}

func renderTable(header []string, rows [][]string) string {
	lines := alignRows(append([][]string{header}, rows...))
	lines[0] = dimOut(lines[0])
	return strings.Join(lines, "\n")
}
