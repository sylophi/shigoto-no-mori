package main

// The worktree name pools (names.go) and the doubutsuNames setting
// that switches between them at create time.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Lowercase kebab-case is also a valid git branch name: no dots,
// slashes, leading dash or anything else check-ref-format rejects.
var kebabName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func doubutsuSet() map[string]bool {
	set := map[string]bool{}
	for _, name := range doubutsuNames() {
		set[name] = true
	}
	return set
}

// A picked name becomes the folder and, by default, the branch, so
// every entry has to survive both unchanged.
func TestNamePoolsAreValidWorktreeNames(t *testing.T) {
	// The pool is the characters with a face (about 500), not a short
	// fallback list.
	if n := len(doubutsuNames()); n < 400 {
		t.Fatalf("doubutsu pool has %d names, want every character with a face", n)
	}
	for _, doubutsu := range []bool{true, false} {
		seen := map[string]bool{}
		for _, name := range namePool(doubutsu) {
			if seen[name] {
				t.Errorf("duplicate name %q", name)
			}
			seen[name] = true
			if !kebabName.MatchString(name) || !isValidWorktreeDirName(name) {
				t.Errorf("name %q is not a valid worktree folder name", name)
			}
		}
	}
}

func TestPickWorktreeNameDrawsFromTheChosenPool(t *testing.T) {
	inPool := doubutsuSet()
	for range 50 {
		if name := pickWorktreeName(map[string]bool{}, true, nil); !inPool[name] {
			t.Fatalf("doubutsu pick %q is not in the pool", name)
		}
		if name := pickWorktreeName(map[string]bool{}, false, nil); inPool[name] || strings.Count(name, "-") != 1 {
			t.Fatalf("default pick %q is not an adjective-animal pair", name)
		}
	}
}

func TestPickWorktreeNameSkipsUsedAndFallsBackToSuffixes(t *testing.T) {
	names := doubutsuNames()
	used := map[string]bool{}
	for _, name := range names[1:] {
		used[name] = true
	}
	if got, want := pickWorktreeName(used, true, nil), names[0]; got != want {
		t.Fatalf("picked %q, want the one unused name %q", got, want)
	}

	used[names[0]] = true
	got := pickWorktreeName(used, true, nil)
	if base := strings.TrimSuffix(got, "-2"); base == got || !used[base] {
		t.Fatalf("with every name used, picked %q, want <name>-2", got)
	}
}

// Off when unset, so an install from before fresh installs were seeded
// keeps its names. The app's pre-pick reads the same default
// (shared/villageLife.ts, pinned by the app's fresh-install proof).
func TestDoubutsuNamesUnsetIsOff(t *testing.T) {
	yes, no := true, false
	for _, tc := range []struct {
		setting *bool
		want    bool
	}{{nil, false}, {&yes, true}, {&no, false}} {
		if got := doubutsuNamesEnabled(globalConfig{DoubutsuNames: tc.setting}); got != tc.want {
			t.Errorf("doubutsuNamesEnabled(%v) = %v, want %v", tc.setting, got, tc.want)
		}
	}
}

func TestCreateHonorsDoubutsuNames(t *testing.T) {
	proj := autoPullSandbox(t)
	inPool := doubutsuSet()

	// The sandbox registered a project without the fresh-install seed,
	// like an install from before it: unset reads as off.
	wt, err := createWorktree(proj, "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if inPool[wt.Name] {
		t.Fatalf("created %q with doubutsuNames unset, want an adjective-animal pair", wt.Name)
	}

	setGlobalBool(t, "doubutsuNames", false)
	wt, err = createWorktree(proj, "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if inPool[wt.Name] {
		t.Fatalf("created %q with doubutsuNames off, want an adjective-animal pair", wt.Name)
	}

	setGlobalBool(t, "doubutsuNames", true)
	wt, err = createWorktree(proj, "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !inPool[wt.Name] {
		t.Fatalf("created %q with doubutsuNames on, want a doubutsu name", wt.Name)
	}
}

// A kept branch (a removed worktree's, say) holds its name: the pick
// becomes the branch name too, and `git worktree add -b` would refuse.
func TestCreateSkipsNamesHeldByBranches(t *testing.T) {
	proj := autoPullSandbox(t)
	setGlobalBool(t, "doubutsuNames", true)

	names := doubutsuNames()
	head, err := runGit(proj.Path, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	var refs strings.Builder
	for _, name := range names[1:] {
		fmt.Fprintf(&refs, "create refs/heads/%s %s\n", name, strings.TrimSpace(head))
	}
	cmd := exec.Command("git", "update-ref", "--stdin")
	cmd.Dir = proj.Path
	cmd.Stdin = strings.NewReader(refs.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("update-ref: %v: %s", err, out)
	}

	wt, err := createWorktree(proj, "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if wt.Name != names[0] {
		t.Fatalf("created %q, want %q, the one name no branch holds", wt.Name, names[0])
	}
}

// With Village life on and the villager data downloaded, the pick
// invites whoever's birthday it is while they're free, and only with
// Doubutsu names on. A leap-day birthday is kept on Feb 28 in common
// years.
func TestBirthdayGuests(t *testing.T) {
	sandboxDataDir(t)
	ready := filepath.Join(dataDir(), "villagers", "ready")
	if err := os.MkdirAll(ready, 0o755); err != nil {
		t.Fatal(err)
	}
	profiles := `{"mitzi":{"name":"Mitzi","birthday":"09-25"},"chester":{"name":"Chester","birthday":"08-06"},"leap":{"name":"Leap","birthday":"02-29"}}`
	if err := os.WriteFile(filepath.Join(ready, "profiles.json"), []byte(profiles), 0o644); err != nil {
		t.Fatal(err)
	}
	on := true
	off := false
	day := time.Date(2026, time.September, 25, 12, 0, 0, 0, time.Local)

	if got := birthdayGuests(globalConfig{DoubutsuNames: &on, VillageLife: &on}, day); len(got) != 1 || got[0] != "mitzi" {
		t.Errorf("guests on 09-25 = %v, want [mitzi]", got)
	}
	if got := birthdayGuests(globalConfig{DoubutsuNames: &on, VillageLife: &off}, day); got != nil {
		t.Errorf("guests with Village life off = %v, want none", got)
	}
	if got := birthdayGuests(globalConfig{DoubutsuNames: &off, VillageLife: &on}, day); got != nil {
		t.Errorf("guests with names off = %v, want none", got)
	}
	common := time.Date(2027, time.February, 28, 12, 0, 0, 0, time.Local)
	if !isBirthdayOn("02-29", common) {
		t.Error("a leap-day birthday isn't kept on Feb 28 in a common year")
	}
	leapYear := time.Date(2028, time.February, 28, 12, 0, 0, 0, time.Local)
	if isBirthdayOn("02-29", leapYear) {
		t.Error("a leap-day birthday lands on Feb 28 in a leap year")
	}

	if got := pickWorktreeName(map[string]bool{}, true, []string{"mitzi"}); got != "mitzi" {
		t.Errorf("pick with mitzi invited = %q", got)
	}
	if got := pickWorktreeName(map[string]bool{"mitzi": true}, true, []string{"mitzi"}); got == "mitzi" {
		t.Error("the pick invited mitzi though her name is taken")
	}
	if got := pickWorktreeName(map[string]bool{}, false, []string{"mitzi"}); got == "mitzi" {
		t.Error("the pick invited mitzi with Doubutsu names off")
	}
	// A key the pool doesn't have is no name to give a folder.
	if got := pickWorktreeName(map[string]bool{}, true, []string{"../x"}); got == "../x" {
		t.Error("the pick invited a name outside the pool")
	}
}
