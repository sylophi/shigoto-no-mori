// cli-launcher: the terminal command on PATH on Windows. Under
// Squirrel.Windows the CLI lives in <root>\app-<version>\resources\,
// a folder every update replaces, so the app copies this launcher into
// <root>\bin\ under each command name and puts that folder on PATH. It
// runs the CLI of the newest version beside it with its own arguments,
// console, environment and working folder, and exits with the CLI's
// exit code. Ctrl+C reaches the CLI through the console they share,
// and the launcher waits for the CLI to end.
//
// The CLI's name is set when the launcher is built, per flavor
// (app/scripts/build-go.mts).
package main

import (
	"cmp"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
)

var program string

func main() {
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	root := filepath.Dir(filepath.Dir(self))
	version, err := newestVersion(root)
	if err != nil {
		fail(err)
	}
	cmd := exec.Command(filepath.Join(root, "app-"+version, "resources", program+".exe"), os.Args[1:]...)
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

// The newest app-<version> folder's version, as Squirrel's own launcher
// picks it: by SemVer precedence, not by date.
func newestVersion(root string) (string, error) {
	folders, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	newest := ""
	for _, folder := range folders {
		version, ok := strings.CutPrefix(folder.Name(), "app-")
		if ok && folder.IsDir() && (newest == "" || compareVersions(version, newest) > 0) {
			newest = version
		}
	}
	if newest == "" {
		return "", fmt.Errorf("no app-<version> folder in %s", root)
	}
	return newest, nil
}

func compareVersions(a, b string) int {
	aCore, aPre, _ := strings.Cut(a, "-")
	bCore, bPre, _ := strings.Cut(b, "-")
	if c := compareFields(aCore, bCore); c != 0 {
		return c
	}
	switch {
	case aPre == bPre:
		return 0
	case aPre == "":
		return 1
	case bPre == "":
		return -1
	}
	return compareFields(aPre, bPre)
}

// Dot-separated fields left to right, a numeric one by its number and
// below any other, the longer list winning a tie.
func compareFields(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := range min(len(as), len(bs)) {
		x, xErr := strconv.Atoi(as[i])
		y, yErr := strconv.Atoi(bs[i])
		var c int
		switch {
		case xErr == nil && yErr == nil:
			c = cmp.Compare(x, y)
		case xErr == nil:
			c = -1
		case yErr == nil:
			c = 1
		default:
			c = strings.Compare(as[i], bs[i])
		}
		if c != 0 {
			return c
		}
	}
	return cmp.Compare(len(as), len(bs))
}
