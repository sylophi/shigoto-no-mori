package main

import (
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseStatusPaths(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		want   []string
	}{
		{"clean", "", nil},
		{"modified and untracked", " M a.txt\x00?? b.txt\x00", []string{"a.txt", "b.txt"}},
		// Staged rename: R in the index column, source in the next field.
		{"staged rename", "R  new.txt\x00old.txt\x00", []string{"new.txt"}},
		// Unstaged rename (git detects these too, e.g. after `git add -N`):
		// R in the WORKTREE column, and it emits a source field all the same.
		{"unstaged rename", " R third.txt\x00new.txt\x00", []string{"third.txt"}},
		{"copy", "C  copy.txt\x00src.txt\x00", []string{"copy.txt"}},
		{"rename then more", " R b.txt\x00a.txt\x00 M c.txt\x00", []string{"b.txt", "c.txt"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseStatusPaths(tc.stdout); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseStatusPaths(%q) = %v, want %v", tc.stdout, got, tc.want)
			}
		})
	}
}

// Checkout mode must land on a branch, never a detached HEAD: the form's
// default base is the remote-first default branch (`origin/main`), which
// a bare `git worktree add <path> origin/main` would detach on.
func TestGitWorktreeCheckoutAttachesHead(t *testing.T) {
	parent := t.TempDir()
	upstream := seedRepo(t, parent, "upstream")
	mustGit(t, upstream, "branch", "feat")
	mustGit(t, upstream, "branch", "remote-only")
	repo := filepath.Join(parent, "repo")
	mustGit(t, parent, "clone", "-q", upstream, repo)
	// Park the clone on a scratch branch so `main` is free to check out.
	mustGit(t, repo, "checkout", "-q", "-b", "scratch")
	// Tracking is set explicitly so the assertions below don't depend on
	// the ambient branch.autoSetupMerge.
	mustGit(t, repo, "branch", "--no-track", "local-only")
	// A pre-existing local `feat`: checking out `origin/feat` must reuse
	// it rather than create a second branch or detach.
	mustGit(t, repo, "branch", "--track", "feat", "origin/feat")
	remotes := listRemotes(repo)

	cases := []struct {
		ref, wantBranch, wantUpstream string
		remotes                       []string // nil: the resolver reads them itself
	}{
		{"origin/main", "main", "origin/main", nil},
		{"origin/feat", "feat", "origin/feat", remotes},
		{"origin/remote-only", "remote-only", "origin/remote-only", remotes},
		{"local-only", "local-only", "", nil},
	}
	for i, tc := range cases {
		wt := filepath.Join(parent, fmt.Sprintf("wt%d", i))
		if err := gitWorktreeCheckout(repo, wt, tc.ref, tc.remotes); err != nil {
			t.Fatalf("%s: %v", tc.ref, err)
		}
		branch, err := runGit(wt, "symbolic-ref", "--short", "HEAD")
		if err != nil {
			t.Fatalf("%s: detached HEAD: %v", tc.ref, err)
		}
		if got := strings.TrimSpace(branch); got != tc.wantBranch {
			t.Errorf("%s: on %q, want %q", tc.ref, got, tc.wantBranch)
		}
		tracking, _ := runGit(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
		if got := strings.TrimSpace(tracking); got != tc.wantUpstream {
			t.Errorf("%s: upstream %q, want %q", tc.ref, got, tc.wantUpstream)
		}
	}
}
