package main

// Tests for the update engine (updater.go): feed parsing against a
// local httptest server, the stage pipeline against a locally built
// release zip (signature verification stubbed -- the fixtures aren't
// signed), the swap sequencing, and the staging lock. Everything runs
// against a temp state root; /Applications is never touched.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func sandboxRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	previous := cachedRoot
	cachedRoot = root
	t.Cleanup(func() { cachedRoot = previous })
	return root
}

func stubVerify(t *testing.T, fn func(installed, candidate string) error) {
	t.Helper()
	previous := verifySignedUpdate
	verifySignedUpdate = fn
	t.Cleanup(func() { verifySignedUpdate = previous })
}

func verifyOK(string, string) error { return nil }

// A fake installed bundle: <dir>/Fake.app/Contents/Resources with a
// marker file recording which "version" the bundle is.
func makeBundle(t *testing.T, parent, marker string) string {
	t.Helper()
	bundle := filepath.Join(parent, "Fake.app")
	resources := filepath.Join(bundle, "Contents", "Resources")
	if err := os.MkdirAll(resources, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "marker"), []byte(marker), 0o644); err != nil {
		t.Fatal(err)
	}
	return bundle
}

func bundleMarker(t *testing.T, bundle string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(bundle, "Contents", "Resources", "marker"))
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	return string(raw)
}

// Zip a fake .app the way releases are zipped (bundle at the top
// level), using ditto like the extractor does.
func makeReleaseZip(t *testing.T, marker string) string {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("ditto is macOS-only")
	}
	src := t.TempDir()
	makeBundle(t, src, marker)
	zipPath := filepath.Join(t.TempDir(), "release.zip")
	if out, err := exec.Command("ditto", "-c", "-k", src, zipPath).CombinedOutput(); err != nil {
		t.Fatalf("ditto -c: %v: %s", err, out)
	}
	return zipPath
}

func TestParseReleaseDate(t *testing.T) {
	cases := map[string]string{
		"2026-08-01T12:30:00Z":            "2026-08-01T12:30:00Z",
		"2026-08-01T12:30:00.000Z":        "2026-08-01T12:30:00Z",
		"Sat, 01 Aug 2026 12:30:00 +0000": "2026-08-01T12:30:00Z",
		"":                                "",
		"not a date":                      "",
	}
	for input, want := range cases {
		if got := parseReleaseDate(input); got != want {
			t.Errorf("parseReleaseDate(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestQueryFeed(t *testing.T) {
	t.Run("up to date", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		defer server.Close()
		t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)
		release, err := queryFeed()
		if err != nil || release != nil {
			t.Fatalf("got (%v, %v), want (nil, nil)", release, err)
		}
	})

	t.Run("update available", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"url":      "https://example.com/app.zip",
				"name":     "v2.3.4",
				"notes":    "notes here",
				"pub_date": "2026-08-01T12:30:00Z",
			})
		}))
		defer server.Close()
		t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)
		release, err := queryFeed()
		if err != nil {
			t.Fatal(err)
		}
		if release.Version != "2.3.4" || release.URL != "https://example.com/app.zip" ||
			release.Notes != "notes here" || release.ReleaseDate != "2026-08-01T12:30:00Z" {
			t.Fatalf("unexpected release: %+v", release)
		}
	})

	t.Run("server error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer server.Close()
		t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)
		if _, err := queryFeed(); err == nil {
			t.Fatal("want error on HTTP 500")
		}
	})

	t.Run("malformed json", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, "{not json")
		}))
		defer server.Close()
		t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)
		if _, err := queryFeed(); err == nil {
			t.Fatal("want error on malformed body")
		}
	})
}

// One handler serving both the feed document and the release zip, so
// stageUpdate can run end-to-end. zipHits counts downloads to assert
// the staged-reuse path skips them.
func releaseServer(t *testing.T, zipPath, version string) (*httptest.Server, *int) {
	t.Helper()
	zipHits := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/release.zip" {
			zipHits++
			http.ServeFile(w, r, zipPath)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"url":  server.URL + "/release.zip",
			"name": "v" + version,
		})
	}))
	t.Cleanup(server.Close)
	return server, &zipHits
}

func TestStageUpdate(t *testing.T) {
	sandboxRoot(t)
	stubVerify(t, verifyOK)
	zipPath := makeReleaseZip(t, "new")
	server, zipHits := releaseServer(t, zipPath, "9.9.9")
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)
	installed := makeBundle(t, t.TempDir(), "old")

	man, err := stageUpdate(installed, func(string, string) {})
	if err != nil {
		t.Fatal(err)
	}
	if man.Version != "9.9.9" || man.BundleName != "Fake.app" {
		t.Fatalf("unexpected manifest: %+v", man)
	}
	if bundleMarker(t, stagedBundlePath(man)) != "new" {
		t.Fatal("staged bundle isn't the downloaded one")
	}
	if got := readStagedManifest(); got == nil || got.Version != "9.9.9" {
		t.Fatalf("readStagedManifest = %+v", got)
	}

	// Second run: same version already staged, no re-download.
	man2, err := stageUpdate(installed, func(string, string) {})
	if err != nil {
		t.Fatal(err)
	}
	if man2.Version != "9.9.9" || *zipHits != 1 {
		t.Fatalf("staged reuse failed: version %s, %d downloads", man2.Version, *zipHits)
	}
}

func TestStageUpdateUpToDateClearsStaged(t *testing.T) {
	sandboxRoot(t)
	stubVerify(t, verifyOK)
	// Pre-existing staged update (e.g. from before the app updated).
	if err := os.MkdirAll(filepath.Join(stagedDir(), "Fake.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteJSON(stagedManifestPath(), &stagedManifest{
		Version: "1.0.0", BundleName: "Fake.app",
	}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)

	man, err := stageUpdate(makeBundle(t, t.TempDir(), "cur"), func(string, string) {})
	if err != nil || man != nil {
		t.Fatalf("got (%+v, %v), want (nil, nil)", man, err)
	}
	if readStagedManifest() != nil {
		t.Fatal("stale staged update survived an up-to-date check")
	}
}

func TestStageUpdateRejectsBadSignature(t *testing.T) {
	sandboxRoot(t)
	stubVerify(t, func(string, string) error { return errf("bad signature") })
	zipPath := makeReleaseZip(t, "evil")
	server, _ := releaseServer(t, zipPath, "9.9.9")
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", server.URL)

	_, err := stageUpdate(makeBundle(t, t.TempDir(), "old"), func(string, string) {})
	if err == nil {
		t.Fatal("want verification error")
	}
	if readStagedManifest() != nil {
		t.Fatal("a bundle that failed verification was staged")
	}
}

func TestSwapBundle(t *testing.T) {
	sandboxRoot(t)
	stubVerify(t, verifyOK)
	appsDir := t.TempDir()
	target := makeBundle(t, appsDir, "old")
	staged := makeBundle(t, t.TempDir(), "new")

	if err := swapBundle(staged, target); err != nil {
		t.Fatal(err)
	}
	if got := bundleMarker(t, target); got != "new" {
		t.Fatalf("target marker = %q, want new", got)
	}
	entries, err := os.ReadDir(appsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("leftovers next to the target: %v", entries)
	}
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Fatal("staged bundle should have moved out")
	}
}

func TestSwapBundleFailedVerifyLeavesTarget(t *testing.T) {
	sandboxRoot(t)
	stubVerify(t, func(string, string) error { return errf("bad signature") })
	appsDir := t.TempDir()
	target := makeBundle(t, appsDir, "old")
	staged := makeBundle(t, t.TempDir(), "new")

	if err := swapBundle(staged, target); err == nil {
		t.Fatal("want verification error")
	}
	if got := bundleMarker(t, target); got != "old" {
		t.Fatalf("target marker = %q, want old (untouched)", got)
	}
	entries, _ := os.ReadDir(appsDir)
	if len(entries) != 1 {
		t.Fatalf("leftovers next to the target: %v", entries)
	}
}

func TestFindExtractedBundle(t *testing.T) {
	dir := t.TempDir()
	if _, err := findExtractedBundle(dir); err == nil {
		t.Fatal("want error with no bundles")
	}
	for _, name := range []string{"A.app", "B.app"} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := findExtractedBundle(dir); err == nil {
		t.Fatal("want error with two bundles")
	}
}

func TestAcquireStagingLock(t *testing.T) {
	sandboxRoot(t)
	unlock, err := acquireStagingLock()
	if err != nil {
		t.Fatal(err)
	}
	// Second acquisition while held by a live pid (our own) must fail
	// with the machine-readable busy code.
	if _, err := acquireStagingLock(); err == nil || errorKindOf(err) != "update-in-progress" {
		t.Fatalf("want update-in-progress error, got %v", err)
	}
	unlock()

	// A stale lock (dead pid) is broken and taken over.
	lockPath := filepath.Join(updatesDir(), "staging.pid")
	if err := os.WriteFile(lockPath, []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	unlock2, err := acquireStagingLock()
	if err != nil {
		t.Fatalf("stale lock not broken: %v", err)
	}
	unlock2()
}

func TestPruneUpdateLeftovers(t *testing.T) {
	sandboxRoot(t)
	appsDir := t.TempDir()
	target := makeBundle(t, appsDir, "cur")
	aside := target + ".old-123"
	incoming := filepath.Join(appsDir, ".Fake.app.new-123")
	for _, dir := range []string{aside, incoming} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(updatesDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(updatesDir(), "download.zip"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	pruneUpdateLeftovers(target)
	for _, gone := range []string{aside, incoming, filepath.Join(updatesDir(), "download.zip")} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s survived pruning", gone)
		}
	}

	// With the target itself missing, the aside is the only surviving
	// copy of the app and must be kept.
	if err := os.MkdirAll(aside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(target); err != nil {
		t.Fatal(err)
	}
	pruneUpdateLeftovers(target)
	if _, err := os.Stat(aside); err != nil {
		t.Error("aside bundle pruned while it was the only copy")
	}
}
