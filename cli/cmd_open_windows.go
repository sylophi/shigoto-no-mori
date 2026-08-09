//go:build windows

package main

// The CLI isn't supported on Windows; the stub keeps the cross-build
// green.

func cmdOpen(_ cliContext, _ []string) (int, error) {
	return 1, errf("open is not supported on Windows.")
}
