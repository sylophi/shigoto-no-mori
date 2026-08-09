package main

// Output contract (mirrors the app-side conventions): command results
// on stdout, progress and streamed script output on stderr, so
// `cd $(sgm path fox)` and agent pipelines stay clean. In --json mode
// stdout carries only JSON: one document for list/path/rm, NDJSON
// events for create's streamed progress.

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
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
	isTTY := func(f *os.File) bool {
		info, err := f.Stat()
		return err == nil && info.Mode()&os.ModeCharDevice != 0
	}
	stdoutColor = isTTY(os.Stdout)
	stderrColor = isTTY(os.Stderr)
}

func paint(s, code string, enabled bool) string {
	if !enabled || s == "" {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func boldOut(s string) string   { return paint(s, "1", stdoutColor) }
func cyanOut(s string) string   { return paint(s, "36", stdoutColor) }
func greenOut(s string) string  { return paint(s, "32", stdoutColor) }
func yellowOut(s string) string { return paint(s, "33", stdoutColor) }
func dimOut(s string) string    { return paint(s, "2", stdoutColor) }
func cyanErr(s string) string   { return paint(s, "36", stderrColor) }
func yellowErr(s string) string { return paint(s, "33", stderrColor) }
func dimErr(s string) string    { return paint(s, "2", stderrColor) }
func redErr(s string) string    { return paint(s, "31", stderrColor) }

var ansiRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

func visibleWidth(s string) int {
	return len([]rune(ansiRe.ReplaceAllString(s, "")))
}

// Usage / operational errors with a chosen exit code. Anything else
// that escapes a command is an environment failure and exits 1.
type cliError struct {
	msg  string
	code int
}

func (e *cliError) Error() string { return e.msg }

func usageErrf(format string, args ...any) error {
	return &cliError{msg: fmt.Sprintf(format, args...), code: 2}
}

func errf(format string, args ...any) error {
	return &cliError{msg: fmt.Sprintf(format, args...), code: 1}
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

func renderTable(header []string, rows [][]string) string {
	all := append([][]string{header}, rows...)
	widths := make([]int, len(header))
	for _, row := range all {
		for i, cell := range row {
			if n := visibleWidth(cell); n > widths[i] {
				widths[i] = n
			}
		}
	}
	var b strings.Builder
	for r, row := range all {
		if r > 0 {
			b.WriteByte('\n')
		}
		line := ""
		for i, cell := range row {
			// visibleWidth: cells may carry ANSI, which must not skew
			// column alignment.
			line += cell + strings.Repeat(" ", widths[i]-visibleWidth(cell)) + "  "
		}
		line = strings.TrimRight(line, " ")
		if r == 0 {
			line = dimOut(line)
		}
		b.WriteString(line)
	}
	return b.String()
}

// Help colorizer: section headers bold, each command/flag's leading
// token cyan. Applied to the plain template so the source stays
// readable; continuation lines (deep indent) pass through untouched.
var helpItemRe = regexp.MustCompile(`^(  )(\S[^ ]*(?: [^ ]+)*?)(  +)(.*)$`)

func colorizeHelp(text string) string {
	if !stdoutColor {
		return text
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		switch {
		case strings.HasSuffix(line, ":") && !strings.HasPrefix(line, " "):
			lines[i] = boldOut(line)
		case strings.HasPrefix(line, "Usage: "):
			lines[i] = boldOut("Usage:") + line[len("Usage:"):]
		default:
			if m := helpItemRe.FindStringSubmatch(line); m != nil {
				lines[i] = m[1] + cyanOut(m[2]) + m[3] + m[4]
			}
		}
	}
	return strings.Join(lines, "\n")
}
