// `go run .github/unelevated.go <command> [args...]` runs a command as
// this account without its administrator rights, as a desktop user runs
// the app. A Windows runner's account is an elevated administrator, and
// an elevated process opens any file past an ACL that denies it, so the
// tests that make the OS refuse them would get nothing refused.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"syscall"
	"unsafe"
)

type sidAndAttributes struct {
	sid        *syscall.SID
	attributes uint32
}

const disableMaxPrivilege = 0x1

var createRestrictedToken = syscall.NewLazyDLL("advapi32.dll").NewProc("CreateRestrictedToken")

func main() {
	token, err := restricted()
	if err != nil {
		fmt.Fprintln(os.Stderr, "unelevated:", err)
		os.Exit(1)
	}
	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// With a token and no environment, Go gives the account's default
	// one. The runner's step summary is its administrators' alone, so
	// vitest is not told of it.
	cmd.Env = slices.DeleteFunc(os.Environ(), func(v string) bool {
		return strings.HasPrefix(v, "GITHUB_STEP_SUMMARY=")
	})
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: token}
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "unelevated:", err)
		os.Exit(1)
	}
}

// This process's token with every privilege but traverse checking
// gone, and the Administrators group only ever denying.
func restricted() (syscall.Token, error) {
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	var own syscall.Token
	access := uint32(syscall.TOKEN_DUPLICATE | syscall.TOKEN_QUERY | syscall.TOKEN_ASSIGN_PRIMARY)
	if err := syscall.OpenProcessToken(process, access, &own); err != nil {
		return 0, err
	}
	admins, err := syscall.StringToSid("S-1-5-32-544")
	if err != nil {
		return 0, err
	}
	disable := sidAndAttributes{sid: admins}
	var token syscall.Token
	ok, _, err := createRestrictedToken.Call(
		uintptr(own), disableMaxPrivilege,
		1, uintptr(unsafe.Pointer(&disable)),
		0, 0, 0, 0,
		uintptr(unsafe.Pointer(&token)),
	)
	if ok == 0 {
		return 0, err
	}
	return token, nil
}
