package main

// The worktree name pools (names.go) and the doubutsuNames setting
// that switches between them at create time.

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"testing"
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
	if n := len(doubutsuNames()); n < 400 {
		t.Fatalf("doubutsu pool has %d names, want the full villager list", n)
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
		if name := pickWorktreeName(map[string]bool{}, true); !inPool[name] {
			t.Fatalf("doubutsu pick %q is not in the pool", name)
		}
		if name := pickWorktreeName(map[string]bool{}, false); inPool[name] || strings.Count(name, "-") != 1 {
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
	if got, want := pickWorktreeName(used, true), names[0]; got != want {
		t.Fatalf("picked %q, want the one unused name %q", got, want)
	}

	used[names[0]] = true
	got := pickWorktreeName(used, true)
	if base := strings.TrimSuffix(got, "-2"); base == got || !used[base] {
		t.Fatalf("with every name used, picked %q, want <name>-2", got)
	}
}

func TestCreateHonorsDoubutsuNames(t *testing.T) {
	proj := autoPullSandbox(t)
	inPool := doubutsuSet()

	setGlobalBool(t, "doubutsuNames", true)
	wt, err := createWorktree(proj, "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !inPool[wt.Name] {
		t.Fatalf("created %q with doubutsuNames on, want a doubutsu name", wt.Name)
	}

	setGlobalBool(t, "doubutsuNames", false)
	wt, err = createWorktree(proj, "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if inPool[wt.Name] {
		t.Fatalf("created %q with doubutsuNames off, want an adjective-animal pair", wt.Name)
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
