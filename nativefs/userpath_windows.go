package main

// The user's own PATH, the Path value under HKCU\Environment, which
// Windows adds to the machine's for every process the user starts:
//
//	nativefs user-path has <dir>      prints true or false
//	nativefs user-path add <dir>      the folder appended, unless there
//	nativefs user-path remove <dir>   the folder taken out, all else kept
//
// The value is read and written as stored, unexpanded and with its
// type, then every window hears that the environment changed, so a
// terminal started after it sees the change.

import (
	"errors"
	"fmt"
	"io"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func userPath(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	verb, dir := args[0], args[1]
	if err := editUserPath(verb, dir, stdout); err != nil {
		fmt.Fprintf(stderr, "nativefs user-path: %v\n", err)
		return 1
	}
	return 0
}

func editUserPath(verb, dir string, stdout io.Writer) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, "Environment", registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	path, kind, err := key.GetStringValue("Path")
	if errors.Is(err, registry.ErrNotExist) {
		path, kind, err = "", registry.EXPAND_SZ, nil
	}
	if err != nil {
		return err
	}
	var edited string
	switch verb {
	case "has":
		_, err := fmt.Fprintln(stdout, hasEntry(path, dir))
		return err
	case "add":
		edited = withEntry(path, dir)
	case "remove":
		edited = withoutEntry(path, dir)
	default:
		return fmt.Errorf("unknown verb %q", verb)
	}
	if edited == path {
		return nil
	}
	if kind == registry.EXPAND_SZ {
		err = key.SetExpandStringValue("Path", edited)
	} else {
		err = key.SetStringValue("Path", edited)
	}
	if err != nil {
		return err
	}
	announceEnvironment()
	return nil
}

var sendMessageTimeout = windows.NewLazySystemDLL("user32.dll").NewProc("SendMessageTimeoutW")

// A window that doesn't answer in time misses the news, not the change.
func announceEnvironment() {
	const (
		hwndBroadcast   = 0xffff
		wmSettingChange = 0x001a
		smtoAbortIfHung = 0x0002
		timeoutMillis   = 5000
	)
	area := windows.StringToUTF16Ptr("Environment")
	sendMessageTimeout.Call(hwndBroadcast, wmSettingChange, 0, uintptr(unsafe.Pointer(area)), smtoAbortIfHung, timeoutMillis, 0)
}
