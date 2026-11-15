package main

import "strings"

// The edits user-path makes to a PATH value, as the registry holds it
// unexpanded: one entry appended or taken out, every other entry, empty
// ones too, left as it was and where it was. Windows matches folders
// whatever their case.

func hasEntry(path, dir string) bool {
	for _, entry := range strings.Split(path, ";") {
		if strings.EqualFold(entry, dir) {
			return true
		}
	}
	return false
}

// A value that ends in a separator keeps ending in one, so taking the
// entry out again gives back the value it was added to.
func withEntry(path, dir string) string {
	switch {
	case hasEntry(path, dir):
		return path
	case path == "":
		return dir
	case strings.HasSuffix(path, ";"):
		return path + dir + ";"
	default:
		return path + ";" + dir
	}
}

func withoutEntry(path, dir string) string {
	var kept []string
	for _, entry := range strings.Split(path, ";") {
		if !strings.EqualFold(entry, dir) {
			kept = append(kept, entry)
		}
	}
	return strings.Join(kept, ";")
}
