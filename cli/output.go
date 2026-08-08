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
	"strings"
)

var (
	jsonMode    bool
	verboseMode bool
)

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
			if n := len([]rune(cell)); n > widths[i] {
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
			line += cell + strings.Repeat(" ", widths[i]-len([]rune(cell))) + "  "
		}
		b.WriteString(strings.TrimRight(line, " "))
	}
	return b.String()
}
