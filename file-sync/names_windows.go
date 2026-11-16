package main

import "strings"

// Why Windows can't hold name as it is, or "". It drops a trailing dot
// or space, so the file would come back under another name and the
// other side would follow it. A device name, with any extension, opens
// the device on older Windows and is out of reach of many tools on
// newer ones.
func unkeepable(name string) string {
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return "Windows can't save a name that ends in a dot or a space"
	}
	base, _, _ := strings.Cut(strings.ToUpper(name), ".")
	switch {
	case base == "CON", base == "PRN", base == "AUX", base == "NUL",
		len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9':
		return "Windows keeps this name for a device"
	}
	return ""
}
