package main

import (
	"os"
	"strings"
	"testing"
)

// git exports GIT_DIR / GIT_INDEX_FILE into hook processes, so a suite
// run from a git hook would otherwise aim every fixture `git init` at
// the parent repo's git directory. Drop every inherited GIT_* once for
// the whole package.
func TestMain(m *testing.M) {
	for _, kv := range os.Environ() {
		if key, _, _ := strings.Cut(kv, "="); strings.HasPrefix(key, "GIT_") {
			os.Unsetenv(key)
		}
	}
	// A data dir of the run's own, so a test that writes state without
	// sandboxDataDir (a clone checkout's verified-files cache) never
	// reaches the real one.
	dir, err := os.MkdirTemp("", "sm-test-data")
	if err != nil {
		panic(err)
	}
	os.Setenv("SHIGOMORI_DATA_DIR", dir)
	if err := initDataDir(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// Runs git in a fixture dir, failing the test on a non-zero exit.
func runGitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := runGit(dir, args...); err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
}

// Fixed dates/author and isolated config make commit SHAs reproducible
// and keep the user's git config out of fixture repos. Inherited GIT_*
// vars are already gone (TestMain).
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
