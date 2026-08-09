//go:build windows

package main

// The CLI isn't supported on Windows (the app keeps its TS engine
// there); the binary still cross-compiles, so give the help renderer
// its fallback width.

func terminalWidth() int { return 0 }
