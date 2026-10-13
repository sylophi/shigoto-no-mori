package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A repo on an Enterprise host reads its merge settings from that
// host, with github.com signed in beside it: gh's api goes to
// github.com unless GH_HOST says otherwise. The fake gh answers only
// when it does, as github.com would know no such repo. A mirror on
// github.com, listed first, doesn't take origin's place, as it doesn't
// in gh's own choice of remote.
func TestGhRunsGoToTheReposOwnHost(t *testing.T) {
	bin := t.TempDir()
	script := `#!/bin/sh
case "$GH_HOST $*" in
  "ghe.example.com api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"autoMergeAllowed":true}}}';;
  *) echo "gh: Could not resolve to a Repository (HTTP 404)" >&2; exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_HOST", "")
	config := t.TempDir()
	hosts := "github.com:\n    user: me\nghe.example.com:\n    user: me\n"
	if err := os.WriteFile(filepath.Join(config, "hosts.yml"), []byte(hosts), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GH_CONFIG_DIR", config)

	dir := t.TempDir()
	mustGit(t, dir, "init", "-q")
	mustGit(t, dir, "remote", "add", "origin", "git@ghe.example.com:o/r.git")
	mustGit(t, dir, "remote", "add", "backup", "git@github.com:o/r.git")
	got := readRepoMergeSettings(dir)
	if !slices.Equal(got.allowed, []string{"squash"}) || !got.autoMerge {
		t.Errorf("readRepoMergeSettings = %+v, want squash only with auto-merge, read from ghe.example.com", got)
	}

	// A host gh isn't signed in to leaves gh's own choice.
	mustGit(t, dir, "remote", "remove", "backup")
	mustGit(t, dir, "remote", "set-url", "origin", "https://git.example.com/o/r.git")
	if host := ghHostFor(dir); host != "" {
		t.Errorf("ghHostFor = %q for a host gh doesn't know, want none", host)
	}
}
