package main

// Parity tests for the repo-identity port: the same JSON fixtures
// scripts/check-identity.mjs feeds the shared TS implementation, so the
// two heads can't drift apart. go:embed can't reach outside cli/, so
// the fixtures load relative to the package directory, where `go test`
// runs.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fixed dates/author and isolated config make commit SHAs reproducible,
// so the fixture file can pin `root:<sha>` values as literals.
// Inherited GIT_* vars are already gone (TestMain).
func deterministicGitEnv(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@t")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@t")
	t.Setenv("GIT_AUTHOR_DATE", "2005-04-07T22:13:13+0000")
	t.Setenv("GIT_COMMITTER_DATE", "2005-04-07T22:13:13+0000")
}

func loadFixture(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "shared", "fixtures", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
}

// *string models the fixtures' explicit null, which is "" on the Go side.
func fromNullable(expected *string) string {
	if expected == nil {
		return ""
	}
	return *expected
}

func TestNormalizeRemoteURLFixtures(t *testing.T) {
	var cases []struct {
		Input    string  `json:"input"`
		Expected *string `json:"expected"`
	}
	loadFixture(t, "repo-identity-urls.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no URL fixture cases")
	}
	for _, c := range cases {
		if got, want := normalizeRemoteURL(c.Input), fromNullable(c.Expected); got != want {
			t.Errorf("normalizeRemoteURL(%q) = %q, want %q", c.Input, got, want)
		}
	}
}

func TestRepoIdentityScenarios(t *testing.T) {
	var scenarios []struct {
		Name  string `json:"name"`
		Repos []struct {
			Dir string     `json:"dir"`
			Git [][]string `json:"git"`
		} `json:"repos"`
		Checks []struct {
			Dir      string  `json:"dir"`
			Expected *string `json:"expected"`
		} `json:"checks"`
	}
	loadFixture(t, "repo-identity-scenarios.json", &scenarios)
	if len(scenarios) == 0 {
		t.Fatal("no identity scenarios")
	}
	deterministicGitEnv(t)
	for _, scenario := range scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			root := t.TempDir()
			for _, repo := range scenario.Repos {
				dir := filepath.Join(root, repo.Dir)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				for _, args := range repo.Git {
					expanded := make([]string, len(args))
					for i, arg := range args {
						expanded[i] = strings.ReplaceAll(arg, "{{root}}", root)
					}
					runGitT(t, dir, expanded...)
				}
			}
			for _, check := range scenario.Checks {
				got, err := computeRepoIdentity(filepath.Join(root, check.Dir))
				if err != nil {
					// Fixtures only pin values: an error is always a git
					// failure the scenario never intends.
					t.Errorf("[%s] identity errored: %v", check.Dir, err)
					continue
				}
				if want := fromNullable(check.Expected); got != want {
					t.Errorf("[%s] identity = %q, want %q", check.Dir, got, want)
				}
			}
		})
	}
}
