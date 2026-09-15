package main

// Tests for the release-picking half of the updater: the semver
// helpers and the prerelease channel rule, the feed dispatch against
// stand-in endpoints, and the on-disk release list. Download,
// signature, and swap need a signed bundle and stay manual
// (MANUAL-TESTING.md).

import (
	"cmp"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseSemver(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want string
		ok   bool
	}{
		{"1.7.1", "1.7.1", true},
		{"v1.7.1", "1.7.1", true},
		{"2.0.0-beta.2", "2.0.0-beta.2", true},
		{"v2.0.0-test.keychain-prompts.1", "2.0.0-test.keychain-prompts.1", true},
		{"2.0.0-beta.2+build.5", "2.0.0-beta.2", true},
		{"2.0.0-0", "2.0.0-0", true},
		{"dev", "", false},
		{"0.17", "", false},
		{"1.02.0", "", false},
		{"2.0.0-", "", false},
		{"2.0.0-beta..1", "", false},
		{"2.0.0-beta_1", "", false},
		{"2.0.0-beta.01", "", false},
	} {
		got, ok := parseSemver(tc.raw)
		if ok != tc.ok {
			t.Errorf("parseSemver(%q) ok = %v, want %v", tc.raw, ok, tc.ok)
			continue
		}
		if ok && got.String() != tc.want {
			t.Errorf("parseSemver(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestCompareSemver(t *testing.T) {
	// Each entry is strictly lower than the next: the semver spec's own
	// precedence example plus the shapes this repo tags.
	ordered := []string{
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
		"1.7.1",
		"1.10.0",
		"2.0.0-beta.1",
		"2.0.0-beta.2",
		"2.0.0-test.keychain-prompts.1",
		"2.0.0",
	}
	parsed := make([]semver, len(ordered))
	for i, raw := range ordered {
		v, ok := parseSemver(raw)
		if !ok {
			t.Fatalf("parseSemver(%q) failed", raw)
		}
		parsed[i] = v
	}
	for i := range parsed {
		for j := range parsed {
			want := cmp.Compare(i, j)
			if got := compareSemver(parsed[i], parsed[j]); got != want {
				t.Errorf("compareSemver(%s, %s) = %d, want %d", ordered[i], ordered[j], got, want)
			}
		}
	}
}

func TestReleaseChannel(t *testing.T) {
	for raw, want := range map[string]string{
		"1.7.1":                         "",
		"2.0.0-beta.1":                  "2.0.0-beta",
		"2.0.0-beta.7":                  "2.0.0-beta",
		"2.0.0-beta":                    "2.0.0-beta",
		"2.0.0-test.keychain-prompts.1": "2.0.0-test.keychain-prompts",
		"2.1.0-beta.1":                  "2.1.0-beta",
		"2.0.0-1":                       "2.0.0-1",
	} {
		v, ok := parseSemver(raw)
		if !ok {
			t.Fatalf("parseSemver(%q) failed", raw)
		}
		if got := releaseChannel(v); got != want {
			t.Errorf("releaseChannel(%s) = %q, want %q", raw, got, want)
		}
	}
}

// A release the way GitHub lists it, with the dmg and the zip the
// makers upload for arch.
func labRelease(tag, arch string) ghRelease {
	ver := strings.TrimPrefix(tag, "v")
	return ghRelease{
		TagName:     tag,
		Prerelease:  strings.Contains(tag, "-"),
		Body:        "notes for " + tag,
		PublishedAt: "2026-09-15T12:00:00Z",
		Assets: []ghAsset{
			{Name: "Shigoto.no.Mori-" + ver + "-" + arch + ".dmg", URL: "https://example.test/" + tag + ".dmg"},
			{Name: "Shigoto.no.Mori-darwin-" + arch + "-" + ver + ".zip", URL: "https://example.test/" + tag + ".zip"},
		},
	}
}

func TestPickRelease(t *testing.T) {
	current, _ := parseSemver("2.0.0-beta.2")
	noAssets := labRelease("v2.0.0-beta.9", "arm64")
	noAssets.Assets = nil
	// Flagged prerelease on GitHub despite a full-release tag: the
	// update server would hide it, and so does the picker.
	flaggedFull := labRelease("v1.9.0", "arm64")
	flaggedFull.Prerelease = true
	releases := []ghRelease{
		labRelease("v2.0.0-beta.1", "arm64"),
		labRelease("v2.0.0-beta.2", "arm64"),
		noAssets,
		flaggedFull,
		labRelease("v2.0.0-test.keychain-prompts.1", "arm64"),
		labRelease("v2.1.0-beta.1", "arm64"),
		labRelease("v1.8.0", "arm64"),
		labRelease("v1.7.1", "arm64"),
		{TagName: "latest"},
	}
	with := func(extra ...ghRelease) []ghRelease { return append(extra, releases...) }

	t.Run("nothing ahead in the channel", func(t *testing.T) {
		if got := pickRelease(current, releases, "arm64"); got != nil {
			t.Fatalf("picked %s, want nil", got.Version)
		}
	})

	t.Run("highest same-channel prerelease wins", func(t *testing.T) {
		got := pickRelease(current, with(labRelease("v2.0.0-beta.4", "arm64"), labRelease("v2.0.0-beta.3", "arm64")), "arm64")
		if got == nil || got.Version != "2.0.0-beta.4" {
			t.Fatalf("picked %+v, want 2.0.0-beta.4", got)
		}
		if got.URL != "https://example.test/v2.0.0-beta.4.zip" || got.Notes != "notes for v2.0.0-beta.4" || got.ReleaseDate != "2026-09-15T12:00:00Z" {
			t.Errorf("release fields = %+v", got)
		}
	})

	t.Run("a full release ahead beats every beta", func(t *testing.T) {
		got := pickRelease(current, with(labRelease("v2.0.0-beta.4", "arm64"), labRelease("v2.0.0", "arm64")), "arm64")
		if got == nil || got.Version != "2.0.0" {
			t.Fatalf("picked %+v, want 2.0.0", got)
		}
	})

	t.Run("other arch has no asset", func(t *testing.T) {
		if got := pickRelease(current, with(labRelease("v2.0.0-beta.3", "arm64")), "x64"); got != nil {
			t.Fatalf("picked %s, want nil", got.Version)
		}
	})
}

func stubVersion(t *testing.T, v string) {
	t.Helper()
	saved := version
	version = v
	t.Cleanup(func() { version = saved })
}

// A stand-in for one endpoint, torn down with the test.
func stubEndpoint(t *testing.T, envVar string, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	t.Setenv(envVar, server.URL)
	return server
}

// A build of version v whose release list comes from handler, with
// the on-disk release list in a sandbox data dir and the freshness
// window closed so every call asks the stand-in.
func stubReleaseList(t *testing.T, v string, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := stubEndpoint(t, "SHIGOMORI_UPDATE_RELEASES_URL", handler)
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", "")
	sandboxDataDir(t)
	stubVersion(t, v)
	saved := releaseListMaxAge
	releaseListMaxAge = 0
	t.Cleanup(func() { releaseListMaxAge = saved })
	return server
}

func serveReleases(releases ...ghRelease) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(releases)
	}
}

func TestQueryFeedFollowsThePrereleaseChannel(t *testing.T) {
	arch := feedArch()
	var gotAccept string
	stubReleaseList(t, "2.0.0-beta.2", func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("Accept")
		serveReleases(
			labRelease("v2.0.0-beta.3", arch),
			labRelease("v2.0.0-beta.2", arch),
			labRelease("v1.7.1", arch),
		)(w, r)
	})

	release, confirmed, err := queryFeed()
	if err != nil {
		t.Fatal(err)
	}
	if release == nil || release.Version != "2.0.0-beta.3" || !confirmed {
		t.Fatalf("release = %+v (confirmed %v), want 2.0.0-beta.3 confirmed", release, confirmed)
	}
	if gotAccept != "application/vnd.github+json" {
		t.Errorf("Accept = %q", gotAccept)
	}
}

func TestQueryFeedAsksTheUpdateServerForFullReleaseBuilds(t *testing.T) {
	listHits := 0
	stubReleaseList(t, "1.7.1", func(w http.ResponseWriter, r *http.Request) {
		listHits++
		w.WriteHeader(http.StatusInternalServerError)
	})
	stubEndpoint(t, "SHIGOMORI_UPDATE_FEED_URL", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	release, confirmed, err := queryFeed()
	if err != nil {
		t.Fatal(err)
	}
	if release != nil || !confirmed {
		t.Fatalf("release = %+v (confirmed %v), want nil confirmed (204)", release, confirmed)
	}
	if listHits != 0 {
		t.Errorf("the release list was queried %d times by a full-release build", listHits)
	}
}

func TestQueryFeedOverrideKeepsAPrereleaseBuildOffTheReleaseList(t *testing.T) {
	listHits := 0
	stubReleaseList(t, "2.0.0-beta.2", func(w http.ResponseWriter, r *http.Request) {
		listHits++
		w.WriteHeader(http.StatusInternalServerError)
	})
	stubEndpoint(t, "SHIGOMORI_UPDATE_FEED_URL", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	release, _, err := queryFeed()
	if err != nil {
		t.Fatal(err)
	}
	if release != nil || listHits != 0 {
		t.Fatalf("release = %+v, list hits = %d; the override must win", release, listHits)
	}
}

func TestFetchReleaseListAnswersFromARecentCopy(t *testing.T) {
	hits := 0
	stubReleaseList(t, "2.0.0-beta.2", func(w http.ResponseWriter, r *http.Request) {
		hits++
		serveReleases(labRelease("v2.0.0-beta.3", "arm64"))(w, r)
	})
	releaseListMaxAge = time.Hour

	if _, confirmed, err := fetchReleaseList(); err != nil || !confirmed {
		t.Fatalf("first fetch: confirmed=%v, err=%v", confirmed, err)
	}
	releases, confirmed, err := fetchReleaseList()
	if err != nil {
		t.Fatal(err)
	}
	if confirmed || hits != 1 || len(releases) != 1 {
		t.Fatalf("second fetch: confirmed=%v, hits=%d, releases=%d; want the copy, unconfirmed, no request", confirmed, hits, len(releases))
	}
}

func TestFetchReleaseListReusesTheCopyOn304AndRateLimit(t *testing.T) {
	status := http.StatusOK
	var headers http.Header
	hits := 0
	stubReleaseList(t, "2.0.0-beta.2", func(w http.ResponseWriter, r *http.Request) {
		hits++
		for k, v := range headers {
			w.Header()[k] = v
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("ETag", `"list-v1"`)
		if r.Header.Get("If-None-Match") == `"list-v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		serveReleases(labRelease("v2.0.0-beta.3", "arm64"))(w, r)
	})

	first, confirmed, err := fetchReleaseList()
	if err != nil || !confirmed || len(first) != 1 {
		t.Fatalf("first fetch: %d releases, confirmed=%v, err=%v", len(first), confirmed, err)
	}

	second, confirmed, err := fetchReleaseList()
	if err != nil || !confirmed || len(second) != 1 || second[0].TagName != "v2.0.0-beta.3" {
		t.Fatalf("304: releases=%+v, confirmed=%v, err=%v", second, confirmed, err)
	}

	status = http.StatusForbidden
	headers = http.Header{
		"X-Ratelimit-Remaining": {"0"},
		"X-Ratelimit-Reset":     {strconv.FormatInt(time.Now().Add(30*time.Minute).Unix(), 10)},
	}
	third, confirmed, err := fetchReleaseList()
	if err != nil || confirmed || len(third) != 1 {
		t.Fatalf("rate limited with a copy: releases=%d, confirmed=%v, err=%v", len(third), confirmed, err)
	}
	// The reset time is remembered: no request until it passes.
	hitsBefore := hits
	if _, confirmed, err := fetchReleaseList(); err != nil || confirmed || hits != hitsBefore {
		t.Fatalf("during the reset window: confirmed=%v, err=%v, hits %d -> %d", confirmed, err, hitsBefore, hits)
	}

	// A plain 403 is a refusal, not a rate limit.
	if err := os.Remove(releaseListCachePath()); err != nil {
		t.Fatal(err)
	}
	headers = nil
	if _, _, err := fetchReleaseList(); err == nil {
		t.Fatal("a 403 without the rate-limit header must be an error")
	}
	headers = http.Header{"X-Ratelimit-Remaining": {"0"}}
	if _, _, err := fetchReleaseList(); err == nil {
		t.Fatal("a rate limit with no copy must be an error")
	}
}

func TestFetchReleaseListIgnoresACopyFromAnotherEndpoint(t *testing.T) {
	stubReleaseList(t, "2.0.0-beta.2", serveReleases(labRelease("v2.0.0-beta.99", "arm64")))
	releaseListMaxAge = time.Hour
	if _, _, err := fetchReleaseList(); err != nil {
		t.Fatal(err)
	}

	hits := 0
	stubEndpoint(t, "SHIGOMORI_UPDATE_RELEASES_URL", func(w http.ResponseWriter, r *http.Request) {
		hits++
		serveReleases(labRelease("v2.0.0-beta.3", "arm64"))(w, r)
	})
	releases, _, err := fetchReleaseList()
	if err != nil {
		t.Fatal(err)
	}
	if hits != 1 || len(releases) != 1 || releases[0].TagName != "v2.0.0-beta.3" {
		t.Fatalf("the other endpoint's copy answered: hits=%d, releases=%+v", hits, releases)
	}
}

// A bundle staged by an earlier run, as stageUpdate leaves it.
func seedStaged(t *testing.T, ver string) {
	t.Helper()
	bundle := filepath.Join(stagedDir(), "Shigoto no Mori.app")
	if err := os.MkdirAll(bundle, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteJSON(stagedManifestPath(), stagedManifest{Version: ver, BundleName: "Shigoto no Mori.app"}); err != nil {
		t.Fatal(err)
	}
}

func TestStageUpdateKeepsAStagedBundleOnAnUnconfirmedAnswer(t *testing.T) {
	arch := feedArch()
	stubReleaseList(t, "2.0.0-beta.2", serveReleases(labRelease("v2.0.0-beta.2", arch)))
	// The on-disk list predates the beta.3 an earlier run staged.
	releaseListMaxAge = time.Hour
	if _, _, err := fetchReleaseList(); err != nil {
		t.Fatal(err)
	}
	seedStaged(t, "2.0.0-beta.3")
	target := t.TempDir()

	man, err := stageUpdate(target, func(string, string) {})
	if err != nil {
		t.Fatal(err)
	}
	if man == nil || man.Version != "2.0.0-beta.3" {
		t.Fatalf("staged manifest = %+v, want the staged beta.3 kept", man)
	}
	if readStagedManifest() == nil {
		t.Fatal("the staged bundle was cleared on an unconfirmed answer")
	}

	// Debris from a finished install (the running version itself) is
	// not offered, though only a confirmed answer sweeps it.
	seedStaged(t, "2.0.0-beta.2")
	if man, err := stageUpdate(target, func(string, string) {}); err != nil || man != nil {
		t.Fatalf("same-version debris offered: %+v, %v", man, err)
	}
	if readStagedManifest() == nil {
		t.Fatal("debris swept without a confirmed answer")
	}

	// Confirmed against the API: nothing newer, so the debris goes.
	releaseListMaxAge = 0
	if man, err := stageUpdate(target, func(string, string) {}); err != nil || man != nil {
		t.Fatalf("confirmed up to date: %+v, %v", man, err)
	}
	if readStagedManifest() != nil {
		t.Fatal("a confirmed up-to-date answer left the staged dir behind")
	}
}
