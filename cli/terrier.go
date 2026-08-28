package main

// Terrier integration (github.com/sylophi/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. Terrier's stable surface is `terrier ls
// --json` plus the rule that a minor version bump is the compatibility
// signal, so that is all this file consumes. Ported alongside
// main/lib/terrier.ts -- the two engines must produce the same merged
// list or the app and the CLI would disagree about which projects
// exist.
//
// Merge semantics: registry.json wins by path. A repo registered in
// both is an ordinary project (removable); one only terrier knows
// becomes a read-only entry with Source "terrier" and a deterministic
// id, so nothing has to be persisted for the two engines to agree.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const terrierBinary = "terrier"

// The registry-read contract this build understands. Terrier's README:
// "a tool checks the minor version and nothing else" -- a minor bump
// means something a tool could be relying on has changed, so an
// unknown minor deactivates the merge rather than guessing. Mirror of
// TERRIER_SUPPORTED_* in main/lib/terrier.ts.
const (
	terrierSupportedMajor = 0
	terrierSupportedMinor = 1
)

// One row of `terrier ls --json`. Slug (the GitHub owner/name) is
// absent for non-GitHub repos; nothing here reads it yet, but decoding
// it keeps the shape honest.
type terrierListing struct {
	Path string `json:"path"`
	Slug string `json:"slug"`
}

var terrierInstalledOnce = sync.OnceValue(func() bool {
	_, err := exec.LookPath(terrierBinary)
	return err == nil
})

func terrierInstalled() bool { return terrierInstalledOnce() }

func terrierEnabled(global globalConfig) bool {
	return global.Terrier != nil && *global.Terrier
}

// "" when the binary is missing or the spawn fails.
var terrierVersionOnce = sync.OnceValue(func() string {
	stdout, err := exec.Command(terrierBinary, "version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(stdout))
})

func terrierCompatible() (ok bool, version string) {
	version = terrierVersionOnce()
	var major, minor int
	if n, _ := fmt.Sscanf(version, "v%d.%d", &major, &minor); n < 2 {
		return false, version
	}
	return major == terrierSupportedMajor && minor == terrierSupportedMinor, version
}

var terrierListOnce = sync.OnceValues(func() ([]terrierListing, error) {
	stdout, err := exec.Command(terrierBinary, "ls", "--json").Output()
	if err != nil {
		return nil, err
	}
	var doc struct {
		Projects []terrierListing `json:"projects"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return nil, err
	}
	return doc.Projects, nil
})

// Deterministic id for a terrier-sourced project: UUID-shaped from
// sha256(path) so the TS engine and this one mint the same id for the
// same path without ever writing it down. Uppercased like every
// CLI-minted id. Mirror of terrierProjectId in main/lib/terrier.ts --
// keep the two byte-for-byte in sync (terrier_test.go pins a vector).
func terrierProjectID(path string) string {
	sum := sha256.Sum256([]byte(path))
	h := strings.ToUpper(hex.EncodeToString(sum[:16]))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// Every activation gate in one place, like portPoolActiveFor: the
// toggle, the binary, and the minor-version handshake.
func terrierActive(global globalConfig) bool {
	if !terrierEnabled(global) || !terrierInstalled() {
		return false
	}
	ok, _ := terrierCompatible()
	return ok
}

// Whether the active terrier registry lists path. False whenever the
// integration is off or unreadable -- callers use this to decide id
// continuity, and "don't know" must act like "no".
func terrierHasPath(path string) bool {
	if !terrierActive(readGlobalConfigHints()) {
		return false
	}
	listings, err := terrierListOnce()
	if err != nil {
		return false
	}
	for _, t := range listings {
		if t.Path == path {
			return true
		}
	}
	return false
}

// The pre-dispatch merge (main.go): registry entries as-is, then a
// read-only project per terrier repo the registry doesn't already
// hold. Failures degrade to the registry alone with one stderr note --
// a broken terrier must not take every command down with it.
func mergeTerrierProjects(projects []project) []project {
	global := readGlobalConfigHints()
	if !terrierEnabled(global) || !terrierInstalled() {
		return projects
	}
	if ok, version := terrierCompatible(); !ok {
		noteTerrierTrouble(fmt.Sprintf(
			"terrier %s isn't a version this build understands (wants v%d.%d), so terrier projects aren't listed.",
			describeTerrierVersion(version), terrierSupportedMajor, terrierSupportedMinor))
		return projects
	}
	listings, err := terrierListOnce()
	if err != nil {
		noteTerrierTrouble("`terrier ls --json` failed (" + err.Error() + "), so terrier projects aren't listed.")
		return projects
	}
	return appendTerrierProjects(projects, listings)
}

// The pure half of the merge, split out for tests. Ordering must match
// mergeTerrierProjects in main/lib/projects/index.ts: registry order
// first, terrier extras after, sorted by name then path (plain byte
// compare in both engines).
func appendTerrierProjects(projects []project, listings []terrierListing) []project {
	known := make(map[string]bool, len(projects))
	for _, p := range projects {
		known[p.Path] = true
	}
	var extras []project
	for _, t := range listings {
		if t.Path == "" || known[t.Path] {
			continue
		}
		known[t.Path] = true
		extras = append(extras, project{
			ID:     terrierProjectID(t.Path),
			Name:   filepath.Base(t.Path),
			Path:   t.Path,
			Source: "terrier",
		})
	}
	if len(extras) == 0 {
		return projects
	}
	sort.Slice(extras, func(i, j int) bool {
		if extras[i].Name != extras[j].Name {
			return extras[i].Name < extras[j].Name
		}
		return extras[i].Path < extras[j].Path
	})
	return append(projects, extras...)
}

func describeTerrierVersion(version string) string {
	if version == "" {
		return "(version unreadable)"
	}
	return version
}

func noteTerrierTrouble(msg string) {
	note(yellowErr("warning:") + " " + msg)
}
