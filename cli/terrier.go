package main

// Terrier integration (github.com/dittofleet/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. `terrier ls --json` is all this file
// consumes, so terrier's version doesn't matter, only whether that
// output still has the shape read here. The CLI owns the merge:
// every command sees the merged list (main.go), and the app reads it
// through `sm projects list --json`. The app does no merge of its own;
// host/lib/terrier.ts only checks terrier's readiness for Settings, and
// runs `terrier add` for the add-project dialog before `sm projects
// add`, which then mints the terrier id (registerProject).
//
// Merge semantics: registry.json wins by path. A repo registered in
// both is an ordinary project (removable), while one only terrier
// knows becomes a read-only entry with Source "terrier" and a
// deterministic id, so nothing has to be persisted for every process
// (and every build) to agree on it.

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const terrierBinary = "terrier"

// A wedged terrier must not hang every CLI invocation, since the merge
// runs pre-dispatch.
const terrierSpawnTimeout = 10 * time.Second

func terrierOutput(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), terrierSpawnTimeout)
	defer cancel()
	return exec.CommandContext(ctx, terrierBinary, args...).Output()
}

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

var terrierListings = sync.OnceValues(func() ([]terrierListing, error) {
	stdout, err := terrierOutput("ls", "--json")
	if err != nil {
		return nil, err
	}
	return parseTerrierListings(stdout)
})

// A missing `projects` or a row without `path` is an error rather than
// an empty list, so a terrier whose output changed shape says so
// instead of quietly listing nothing.
func parseTerrierListings(stdout []byte) ([]terrierListing, error) {
	var doc struct {
		Projects *[]struct {
			Path *string `json:"path"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return nil, err
	}
	if doc.Projects == nil {
		return nil, errors.New("no projects list in its output")
	}
	// Home-expanded and required to be absolute, never resolved
	// against cwd: that differs between the app's spawn and a shell, so
	// the same relative row could mint different ids.
	var listings []terrierListing
	for _, t := range *doc.Projects {
		if t.Path == nil {
			return nil, errors.New("a project without a path in its output")
		}
		path := expandHome(*t.Path)
		if path == "" || !filepath.IsAbs(path) {
			continue
		}
		listings = append(listings, terrierListing{Path: path})
	}
	return listings, nil
}

// Deterministic id for a terrier-sourced project: UUID-shaped from
// sha256(path), so every process mints the same id for the same path
// without ever writing it down. Uppercased like every CLI-minted id.
// Fixed for good: per-project state and the app's id-keyed caches live
// under it, and earlier builds minted it the same way (terrier_test.go
// pins a vector).
func terrierProjectID(path string) string {
	sum := sha256.Sum256([]byte(path))
	h := strings.ToUpper(hex.EncodeToString(sum[:16]))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// Why the registry can't be read right now, or nil when it can. The
// one walk of the installed -> readable ladder, feeding
// the merge's stderr warning and doctor's finding with the same words
// so the two can never explain the same "off" state differently.
// Assumes the caller already checked terrierEnabled: an off toggle is
// the normal quiet state, not trouble. Memoized, since every input is
// a process-lifetime constant.
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
	if _, err := terrierListings(); err != nil {
		return &terrierTrouble{
			summary: "`terrier ls --json` failed (" + err.Error() + "), so no terrier projects are listed",
			advice:  "Run `terrier ls --json` by hand to see what it says, and update " + binaryName + " if its output changed.",
		}
	}
	return nil
})

// The whole gate in one call: nil listings whenever the toggle is off
// or the registry is unreadable (trouble says which, and nil trouble
// with nil listings means simply disabled). Every consumer of the terrier
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
// integration is off or unreadable. Callers use this to decide id
// continuity, and "don't know" must act like "no".
func terrierHasPath(path string) bool {
	listings, _ := activeTerrierListings()
	return slices.ContainsFunc(listings, func(t terrierListing) bool { return t.Path == path })
}

// The pre-dispatch merge (main.go): registry entries as-is, then a
// read-only project per terrier repo the registry doesn't already
// hold. Failures degrade to the registry alone with one stderr note,
// since a broken terrier must not take every command down with it.
func mergeTerrierProjects(projects []project) []project {
	listings, trouble := activeTerrierListings()
	if trouble != nil {
		note(yellowErr("warning:") + " " + trouble.summary + ".")
	}
	return appendTerrierProjects(projects, listings)
}

// The pure half of the merge, split out for tests. Registry order
// first, terrier extras after, sorted by name then path (plain byte
// compare). This is only the default: the manual order
// (orderProjects) goes over the merged list.
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
	slices.SortFunc(extras, func(a, b project) int {
		return cmp.Or(strings.Compare(a.Name, b.Name), strings.Compare(a.Path, b.Path))
	})
	return append(projects, extras...)
}
