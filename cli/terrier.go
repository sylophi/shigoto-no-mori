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
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const terrierBinary = "terrier"

// A wedged terrier must not hang every CLI invocation — the merge runs
// pre-dispatch. Mirror of TERRIER_SPAWN_TIMEOUT_MS in
// main/lib/terrier.ts.
const terrierSpawnTimeout = 10 * time.Second

func terrierOutput(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), terrierSpawnTimeout)
	defer cancel()
	return exec.CommandContext(ctx, terrierBinary, args...).Output()
}

// The registry-read contract this build understands. Terrier's README:
// "a tool checks the minor version and nothing else" -- a minor bump
// means something a tool could be relying on has changed, so an
// unknown minor deactivates the merge rather than guessing. Mirror of
// TERRIER_SUPPORTED_* in main/lib/terrier.ts.
const (
	terrierSupportedMajor = 0
	terrierSupportedMinor = 1
)

// One row of `terrier ls --json`.
type terrierListing struct {
	Path string `json:"path"`
}

var terrierInstalled = sync.OnceValue(func() bool {
	_, err := exec.LookPath(terrierBinary)
	return err == nil
})

func terrierEnabled(global globalConfig) bool {
	return global.Terrier != nil && *global.Terrier
}

// "" when the binary is missing or the spawn fails.
var terrierVersion = sync.OnceValue(func() string {
	stdout, err := terrierOutput("version")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(stdout))
})

func terrierCompatible() (ok bool, version string) {
	version = terrierVersion()
	var major, minor int
	if n, _ := fmt.Sscanf(version, "v%d.%d", &major, &minor); n < 2 {
		return false, version
	}
	return major == terrierSupportedMajor && minor == terrierSupportedMinor, version
}

var terrierListings = sync.OnceValues(func() ([]terrierListing, error) {
	stdout, err := terrierOutput("ls", "--json")
	if err != nil {
		return nil, err
	}
	var doc struct {
		Projects []terrierListing `json:"projects"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return nil, err
	}
	// Home-expanded and required to be absolute — never resolved
	// against cwd, which differs between the app and a shell, so the
	// two engines could mint different ids for the same relative row.
	// Mirrors the filter in main/lib/terrier.ts's listing read.
	var listings []terrierListing
	for _, t := range doc.Projects {
		path := expandHome(t.Path)
		if path == "" || !filepath.IsAbs(path) {
			continue
		}
		listings = append(listings, terrierListing{Path: path})
	}
	return listings, nil
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

// Why the registry can't be read right now, or nil when it can. The
// one walk of the installed -> compatible -> readable ladder, feeding
// the merge's stderr warning and doctor's finding with the same words
// so the two can never explain the same "off" state differently.
// Assumes the caller already checked terrierEnabled: an off toggle is
// the normal quiet state, not trouble. Memoized -- every input is a
// process-lifetime constant.
type terrierTrouble struct {
	summary, advice string
}

var terrierTroubleFor = sync.OnceValue(func() *terrierTrouble {
	if !terrierInstalled() {
		return &terrierTrouble{
			summary: "enabled in config.json but `terrier` isn't on PATH, so no terrier projects are listed",
			advice:  "Install terrier, or turn the toggle off in the app's Settings.",
		}
	}
	if ok, version := terrierCompatible(); !ok {
		return &terrierTrouble{
			summary: fmt.Sprintf("%s isn't a version this build understands (wants v%d.%d), so no terrier projects are listed",
				describeTerrierVersion(version), terrierSupportedMajor, terrierSupportedMinor),
			advice: "Update " + binaryName + " and terrier to versions that agree.",
		}
	}
	if _, err := terrierListings(); err != nil {
		return &terrierTrouble{
			summary: "`terrier ls --json` failed: " + err.Error(),
			advice:  "Run `terrier ls` by hand to see what it says.",
		}
	}
	return nil
})

// The whole gate in one call: nil listings whenever the toggle is off
// or the registry is unreadable (trouble says which; nil trouble with
// nil listings means simply disabled). Every consumer of the terrier
// registry goes through here so no call site can walk the ladder
// differently.
func activeTerrierListings() ([]terrierListing, *terrierTrouble) {
	if !terrierEnabled(readGlobalConfigHints()) {
		return nil, nil
	}
	if trouble := terrierTroubleFor(); trouble != nil {
		return nil, trouble
	}
	listings, _ := terrierListings()
	return listings, nil
}

// Whether the active terrier registry lists path. False whenever the
// integration is off or unreadable -- callers use this to decide id
// continuity, and "don't know" must act like "no". Mirror of
// terrierHasPath in main/lib/terrier.ts.
func terrierHasPath(path string) bool {
	listings, _ := activeTerrierListings()
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
	listings, trouble := activeTerrierListings()
	if trouble != nil {
		note(yellowErr("warning:") + " " + trouble.summary + ".")
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
