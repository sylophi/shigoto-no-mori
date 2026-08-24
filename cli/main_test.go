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
	os.Exit(m.Run())
}

// Runs git in a fixture dir, failing the test on a non-zero exit.
func runGitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := runGit(dir, args...); err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
}
