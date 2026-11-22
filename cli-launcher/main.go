// cli-launcher: the terminal command on PATH on Windows. The CLI lives
// in <root>\current\resources\, among the app's other binaries, so the
// app copies this launcher into <root>\bin\ under each command name and
// puts that folder on PATH. It runs the CLI with its own arguments,
// console, environment and working folder, and exits with the CLI's
// exit code. Ctrl+C reaches the CLI through the console they share,
// and the launcher waits for the CLI to end.
//
// The CLI's name is set when the launcher is built, per flavor
// (app/scripts/build-go.mts).
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
)

var program string

func main() {
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	root := filepath.Dir(filepath.Dir(self))
	cmd := exec.Command(filepath.Join(root, "current", "resources", program+".exe"), os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Taken, so the launcher outlives the CLI's handling of it.
	signal.Notify(make(chan os.Signal, 1), os.Interrupt)
	err = cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe"), err)
	os.Exit(1)
}
