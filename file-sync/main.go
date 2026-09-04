package main

// The argv shell over engine.go. Two subcommands, both app plumbing
// (see the engine header): `serve` and `daemon`. Exit status 2 is a
// usage error, 1 a runtime failure.

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

// The parent-death tripwire (see the lifecycle note in engine.go):
// both roles are children of the host and must not outlive it. When
// the host dies, the kernel reparents this process (to launchd or
// init), so a changed parent pid is the host being gone. Polled,
// because macOS has no parent-death signal. Stdin EOF usually wins the
// race anyway, and this catches the cases where it cannot (a host that
// leaked the pipe's write end to another child, say).
func watchParent(interval time.Duration) {
	parent := os.Getppid()
	go func() {
		for {
			time.Sleep(interval)
			if os.Getppid() != parent {
				fmt.Fprintln(os.Stderr, "file-sync: host process is gone, exiting")
				os.Exit(0)
			}
		}
	}()
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: file-sync serve | file-sync daemon --gateway <host:port> --data-dir <dir>")
}

func run(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}
	switch args[0] {
	case "serve", "daemon":
		watchParent(2 * time.Second)
	}
	switch args[0] {
	case "serve":
		// stdout IS the protocol stream here, so nothing else may print
		// to it. Diagnostics go to stderr.
		err := serveMirrorEndpoint(stdioStream{in: os.Stdin, out: os.Stdout}, os.Stderr)
		// The client hanging up is how every stream ends (the session was
		// terminated, the peer went away, the app quit), and Mutagen
		// reports it as a read hitting EOF. That is a clean exit, not an
		// error to print.
		if err != nil && !strings.Contains(err.Error(), "EOF") {
			fmt.Fprintln(os.Stderr, "file-sync serve:", err)
			return 1
		}
		return 0
	case "daemon":
		flags := flag.NewFlagSet("daemon", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		gateway := flags.String("gateway", "", "loopback host:port the host's mirror gateway listens on")
		dataDir := flags.String("data-dir", "", "absolute directory sessions persist under")
		if err := flags.Parse(args[1:]); err != nil {
			return 2
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		err := runMirrorDaemon(ctx, os.Stdin, os.Stdout, *gateway, *dataDir, os.Stderr)
		if err != nil {
			fmt.Fprintln(os.Stderr, "file-sync daemon:", err)
			return 1
		}
		return 0
	case "-h", "--help", "help":
		usage()
		return 0
	default:
		usage()
		return 2
	}
}
