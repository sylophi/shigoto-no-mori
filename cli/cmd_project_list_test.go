package main

// sm projects list --json rows (the app's ProjectSchema fields plus
// icon and hue), sm projects icon, and the repo identity they carry.

import (
	"encoding/base64"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The same table the app's normalizeRemoteUrl is written against: the
// two must reduce every remote to the same key or two devices disagree
// about which repo is which.
func TestNormalizeRemoteURL(t *testing.T) {
	cases := map[string]string{
		"git@github.com:owner/repo.git":               "github.com/owner/repo",
		"github.com:owner/repo":                       "github.com/owner/repo",
		"https://github.com/owner/repo":               "github.com/owner/repo",
		"https://user:tok@GitHub.com:443/Owner/Repo/": "github.com/Owner/Repo",
		"ssh://git@ssh.github.com:443/owner/repo.git": "github.com/owner/repo",
		"  https://example.com/a/b.git//  ":           "example.com/a/b",
		"file:///srv/repo.git":                        "",
		"FILE:///srv/repo.git":                        "",
		"/srv/repo.git":                               "",
		"./repo":                                      "",
		"../repo":                                     "",
		"~/repo":                                      "",
		"C:/repo":                                     "",
		"dir/with:colon":                              "",
		"no-colon-at-all":                             "",
		"":                                            "",
		"https://github.com/":                         "",
	}
	for in, want := range cases {
		if got := normalizeRemoteURL(in); got != want {
			t.Errorf("normalizeRemoteURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRepoIdentity(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "repo")
	rootSHA := strings.TrimSpace(gitOut(t, repo, "rev-list", "--max-parents=0", "HEAD"))
	if got := repoIdentity(repo); got != "root:"+rootSHA {
		t.Errorf("identity = %q, want root:%s", got, rootSHA)
	}

	// No default ref to walk (an unborn main): the remote decides, and
	// upstream outranks origin.
	bare := filepath.Join(root, "unborn")
	runGitT(t, root, "init", "-q", "-b", "main", bare)
	runGitT(t, bare, "remote", "add", "origin", "git@github.com:me/fork.git")
	runGitT(t, bare, "remote", "add", "upstream", "https://github.com/them/repo.git")
	if got := repoIdentity(bare); got != "remote:github.com/them/repo" {
		t.Errorf("remote identity = %q, want remote:github.com/them/repo", got)
	}
	// Machine-local remotes never identify.
	local := filepath.Join(root, "local")
	runGitT(t, root, "init", "-q", "-b", "main", local)
	runGitT(t, local, "remote", "add", "origin", "/srv/repo.git")
	if got := repoIdentity(local); got != "" {
		t.Errorf("path-remote identity = %q, want none", got)
	}
}

// The icon index is snapshotted once per process; a test reading its
// own sandbox's index needs a fresh snapshot (and leaves one behind).
func resetIconSnapshot(t *testing.T) {
	t.Helper()
	cachedIconIndex = sync.OnceValue(readIconCache)
	t.Cleanup(func() { cachedIconIndex = sync.OnceValue(readIconCache) })
}

// An SVG whose only chromatic color is a saturated red, so the hue is
// well-defined.
const redIconSVG = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#e11d48" width="9" height="9"/></svg>`

func TestProjectListRows(t *testing.T) {
	root := sandboxDataDir(t)
	resetIconSnapshot(t)
	withIcon := seedRepo(t, root, "withicon")
	writeFileT(t, filepath.Join(withIcon, "favicon.svg"), redIconSVG)
	bare := seedRepo(t, root, "plain")
	projects := []project{
		{ID: "P1", Name: "withicon", Path: withIcon},
		{ID: "P2", Name: "plain", Path: bare},
		{ID: "P3", Name: "gone", Path: filepath.Join(root, "gone"), Source: "terrier"},
	}
	now := time.Now().UnixMilli()
	old := now - (30 * 24 * time.Hour).Milliseconds()
	seedState(t, fmt.Sprintf(`{"projectUseLog":{"P1":[%d,%d,%d]}}`, old, now-1000, now))

	ctx := cliContext{projects: projects}
	list := func(args ...string) []map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdProjectList(ctx, args); code != 0 || err != nil {
				t.Fatalf("projects list: %d, %v", code, err)
			}
		})
		return decodeT[[]map[string]any](t, onlyDoc(t, docs))
	}
	rows := list()
	if len(rows) != 3 {
		t.Fatalf("rows = %v", rows)
	}
	icon, _ := rows[0]["icon"].(map[string]any)
	if icon["path"] != filepath.Join(withIcon, "favicon.svg") || icon["mime"] != "image/svg+xml" {
		t.Errorf("icon = %v", rows[0]["icon"])
	}
	if hue, ok := rows[0]["hue"].(float64); !ok || (hue > 30 && hue < 330) {
		t.Errorf("hue = %v, want a red", rows[0]["hue"])
	}
	if rows[0]["lastUsed"] != float64(now) || rows[0]["recentCount"] != float64(2) {
		t.Errorf("usage = %v/%v, want %d/2", rows[0]["lastUsed"], rows[0]["recentCount"], now)
	}
	if id, _ := rows[0]["identity"].(string); !strings.HasPrefix(id, "root:") || rows[0]["pathExists"] != true {
		t.Errorf("identity %v pathExists %v", rows[0]["identity"], rows[0]["pathExists"])
	}
	if rows[1]["icon"] != nil || rows[1]["hue"] != nil || rows[1]["lastUsed"] != float64(0) {
		t.Errorf("plain row = %v, want null icon and hue, never used", rows[1])
	}
	if _, has := rows[1]["source"]; has {
		t.Errorf("a registry row carries source: %v", rows[1])
	}
	if rows[2]["pathExists"] != false || rows[2]["identity"] != nil || rows[2]["source"] != "terrier" {
		t.Errorf("missing-path row = %v", rows[2])
	}

	// The miss is cached: an icon added now stays unseen until the
	// caller asks for misses to be re-scanned.
	writeFileT(t, filepath.Join(bare, "favicon.svg"), redIconSVG)
	resetIconSnapshot(t)
	if rows := list(); rows[1]["icon"] != nil {
		t.Errorf("a cached miss re-scanned without --refresh-icons: %v", rows[1]["icon"])
	}
	resetIconSnapshot(t)
	if rows := list("--refresh-icons"); rows[1]["icon"] == nil {
		t.Error("--refresh-icons didn't pick up the new icon")
	}
}

func TestProjectIconBytes(t *testing.T) {
	root := sandboxDataDir(t)
	resetIconSnapshot(t)
	repo := seedRepo(t, root, "repo")
	writeFileT(t, filepath.Join(repo, "public", "favicon.svg"), redIconSVG)
	plain := seedRepo(t, root, "plain")
	ctx := cliContext{projects: []project{{ID: "P1", Name: "repo", Path: repo}, {ID: "P2", Name: "plain", Path: plain}}}

	docs := captureJSON(t, func() {
		if code, err := cmdProjectIcon(ctx, []string{"--project-id", "P1"}); code != 0 || err != nil {
			t.Fatalf("icon: %d, %v", code, err)
		}
	})
	icon := decodeT[projectIconBytes](t, onlyDoc(t, docs))
	decoded, err := base64.StdEncoding.DecodeString(icon.Base64)
	if err != nil || string(decoded) != redIconSVG || icon.Mime != "image/svg+xml" {
		t.Errorf("icon = %+v (%v)", icon, err)
	}
	docs = captureJSON(t, func() {
		if code, err := cmdProjectIcon(ctx, []string{"plain"}); code != 0 || err != nil {
			t.Fatalf("icon plain: %d, %v", code, err)
		}
	})
	if string(onlyDoc(t, docs)) != "null" {
		t.Errorf("icon-less project = %s, want null", onlyDoc(t, docs))
	}
}

// Removing a project drops its icon cache entry (keyed by path), and
// only its own.
func TestProjectRemoveForgetsIcon(t *testing.T) {
	root := sandboxDataDir(t)
	resetIconSnapshot(t)
	repo := seedRepo(t, root, "repo")
	writeFileT(t, filepath.Join(repo, "public", "favicon.svg"), redIconSVG)
	other := seedRepo(t, root, "other")
	seedRegistry(t, fmt.Sprintf(
		`{"projects":[{"id":"P1","name":"repo","path":%q},{"id":"P2","name":"other","path":%q}]}`,
		repo, other))
	ctx := cliContext{projects: []project{
		{ID: "P1", Name: "repo", Path: repo},
		{ID: "P2", Name: "other", Path: other},
	}}
	captureJSON(t, func() {
		for _, id := range []string{"P1", "P2"} {
			if code, err := cmdProjectIcon(ctx, []string{"--project-id", id}); code != 0 || err != nil {
				t.Fatalf("icon %s: %d, %v", id, code, err)
			}
		}
	})
	if index := readIconCache(); len(index) != 2 {
		t.Fatalf("icon cache holds %d entries, want 2", len(index))
	}
	captureJSON(t, func() {
		if code, err := cmdProjectRemove(ctx, []string{"--project-id", "P1", "--yes"}); code != 0 || err != nil {
			t.Fatalf("remove: %d, %v", code, err)
		}
	})
	index := readIconCache()
	if _, ok := index[repo]; ok {
		t.Errorf("the removed project's icon entry survived")
	}
	if _, ok := index[other]; !ok {
		t.Errorf("another project's icon entry went with it")
	}
}
