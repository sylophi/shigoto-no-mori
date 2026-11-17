package main

import (
	"regexp"
	"strings"
)

// A name Windows reads as a device, whatever its case or extension. The
// same list as DEVICE_NAME in
// packages/contracts/src/predicates/worktreeDirName.ts.
var deviceName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)`)

// Why Windows can't hold name as it is, or "". It drops a trailing dot
// or space, so the file would come back under another name and the
// other side would follow it. A device name opens the device on older
// Windows and is out of reach of many tools on newer ones.
func unkeepable(name string) string {
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return "Windows can't save a name that ends in a dot or a space"
	}
	if deviceName.MatchString(name) {
		return "Windows keeps this name for a device"
	}
	return ""
}
