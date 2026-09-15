package main

// The update engine behind `sm update` (cmd_update.go). The CLI owns
// the whole pipeline. The app is not involved until the moment a
// running instance has to restart:
//   query    find the release to move to. A full release asks the
//            update.electronjs.org feed for this repo/arch/version and
//            lets the server compare versions (204 = up to date, 200 =
//            JSON pointing at the release zip). That feed hides
//            prereleases, so a PRERELEASE build reads the repo's
//            release list from the GitHub API instead and picks the
//            highest of: any full release ahead of it, or a later
//            prerelease in its own channel (semver.go releaseChannel).
//   stage    download the zip under <dataDir>/updates, extract it, verify
//            the code signature, and park the new bundle in
//            updates/staged with a manifest describing it.
//   swap     replace the installed bundle with the staged one. The
//            sequence is crash-safe by ordering: the new bundle is
//            first placed *next to* the target (the only step that can
//            be slow or cross-volume), signature-verified again in its
//            final location, and only then swapped in via two
//            same-directory renames with a rollback in between.
// Trust model: transport is HTTPS, but the anchor is Apple's code
// signature. A staged bundle installs only if `codesign --verify`
// passes and its Team ID matches the installed app's. A compromised
// feed can therefore redirect to a different release of ours, not to
// arbitrary code. Verification failures always fail closed.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const feedTimeout = 30 * time.Second

// Generous whole-request budget for the zip download (~200MB on a slow
// connection); the CLI has no byte-progress UI, so this is the only
// thing that unsticks a blackholed connection.
const downloadTimeout = 20 * time.Minute

func updatesDir() string { return filepath.Join(dataDir(), "updates") }
func stagedDir() string  { return filepath.Join(updatesDir(), "staged") }
func stagedManifestPath() string {
	return filepath.Join(stagedDir(), "manifest.json")
}

// What the feed said about the latest release.
type releaseInfo struct {
	URL     string
	Version string
	Notes   string
	// ISO 8601, or "" when the feed's pub_date is absent/unparseable.
	ReleaseDate string
}

// Describes the verified bundle sitting in updates/staged. Mirrors
// StagedManifestSchema (shared/schemas/runtime.ts): the app reads this
// file to seed its "ready" state and to decide whether "restart to
// update" has anything to restart into.
type stagedManifest struct {
	Version     string `json:"version"`
	BundleName  string `json:"bundleName"`
	Notes       string `json:"notes,omitempty"`
	ReleaseDate string `json:"releaseDate,omitempty"`
}

func stagedBundlePath(man *stagedManifest) string {
	return filepath.Join(stagedDir(), man.BundleName)
}

// --- feed ---

var feedClient = &http.Client{Timeout: feedTimeout}

// `SHIGOMORI_UPDATE_FEED_URL` points a signed build at a stand-in for
// the update server (MANUAL-TESTING.md). It forces that single-answer
// path on every build, prerelease or not, so the variable a tester
// has always used keeps a test build off the real feeds.
func feedOverride() string {
	return strings.TrimSpace(os.Getenv("SHIGOMORI_UPDATE_FEED_URL"))
}

func updateServerURL() string {
	if override := feedOverride(); override != "" {
		return override
	}
	return "https://update.electronjs.org/" + updateFeedRepo + "/darwin-" + feedArch() + "/" + version
}

// `SHIGOMORI_UPDATE_RELEASES_URL` is the prerelease path's stand-in:
// a URL serving the GitHub release-list JSON. 100 is the API's page
// maximum. The list is ordered by the tagged commit's date, not by
// version, so a prerelease cut from an old commit sinks. Once the repo
// passes 100 releases such a tag could fall off the page.
func releaseListURL() string {
	if override := strings.TrimSpace(os.Getenv("SHIGOMORI_UPDATE_RELEASES_URL")); override != "" {
		return override
	}
	return "https://api.github.com/repos/" + updateFeedRepo + "/releases?per_page=100"
}

// Electron's process.arch spelling, which names the release assets.
func feedArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

// What a check learned: the release to move to (nil: nothing newer),
// and whether that answer came from the network this run. A
// release-list answer served from the on-disk copy (recent enough, or
// the API rate-limiting us) is unconfirmed: it can lag a release an
// earlier run already staged, so it must not be taken as "up to date"
// for anything destructive.
//
// A prerelease build ranks the release list itself (the release
// workflow stamps the tag into package.json, so v2.0.0-beta.2 ships as
// "2.0.0-beta.2"). Every other build lets the update server compare.
func queryFeed() (release *releaseInfo, confirmed bool, err error) {
	if feedOverride() == "" {
		if current, ok := parseSemver(version); ok && current.isPrerelease() {
			return queryReleaseList(current)
		}
	}
	release, err = queryUpdateServer()
	return release, true, err
}

func newFeedRequest(url string) (*http.Request, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, errf("Bad update URL %q: %v", url, err)
	}
	req.Header.Set("User-Agent", "shigoto-no-mori-cli/"+version)
	return req, nil
}

// The server compares versions and answers 204 when there is nothing
// newer. Any other non-200 answer is an error: this build's version is
// in the URL, so 404s and friends mean a broken feed, not a missing
// update.
func queryUpdateServer() (*releaseInfo, error) {
	req, err := newFeedRequest(updateServerURL())
	if err != nil {
		return nil, err
	}
	resp, err := feedClient.Do(req)
	if err != nil {
		return nil, errf("Couldn't reach the update feed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errf("The update feed answered HTTP %d.", resp.StatusCode)
	}
	var doc struct {
		URL     string `json:"url"`
		Name    string `json:"name"`
		Notes   string `json:"notes"`
		PubDate string `json:"pub_date"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, errf("The update feed answered malformed JSON: %v", err)
	}
	newVersion := strings.TrimPrefix(doc.Name, "v")
	if doc.URL == "" || newVersion == "" {
		return nil, errf("The update feed answered without a release URL or name.")
	}
	return &releaseInfo{
		URL:         doc.URL,
		Version:     newVersion,
		Notes:       doc.Notes,
		ReleaseDate: parseReleaseDate(doc.PubDate),
	}, nil
}

// One entry of the GitHub releases API, the fields the picker reads.
// Drafts never reach an unauthenticated caller, so there is no flag
// for them.
type ghRelease struct {
	TagName     string    `json:"tag_name"`
	Prerelease  bool      `json:"prerelease"`
	Body        string    `json:"body"`
	PublishedAt string    `json:"published_at"`
	Assets      []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

// How long a fetched release list answers checks on its own. The app
// asks every 10 minutes and a terminal check can land in between.
// Unauthenticated requests get 60 an hour per address, shared with
// every other unauthenticated tool on the network, so bursts are
// coalesced rather than sent. Swappable for tests.
var releaseListMaxAge = 15 * time.Minute

// The last release list the API served, kept beside the staged
// bundle. Within releaseListMaxAge it answers on its own. After that
// the next request carries its ETag (a 304 is free of the rate limit,
// though GitHub's ETag covers every asset's download count, so a 304
// is a bonus rather than the norm). When the API says the hourly
// budget is spent, RetryAt records when to ask again and the list
// keeps answering until then: stale by at most the reset window,
// instead of an error in Settings.
type releaseListCache struct {
	// The endpoint it came from: a stand-in's list must not answer for
	// the real one, or the reverse.
	URL       string    `json:"url"`
	FetchedAt time.Time `json:"fetchedAt"`
	ETag      string    `json:"etag,omitempty"`
	RetryAt   time.Time `json:"retryAt"`
	// The list as the API sent it, decoded on use so a newer build
	// reads whatever fields it knows.
	Body json.RawMessage `json:"body"`
}

func releaseListCachePath() string {
	return filepath.Join(updatesDir(), "release-list.json")
}

func readReleaseListCache(url string) *releaseListCache {
	raw, err := os.ReadFile(releaseListCachePath())
	if err != nil {
		return nil
	}
	var cache releaseListCache
	if json.Unmarshal(raw, &cache) != nil || cache.URL != url || len(cache.Body) == 0 {
		return nil
	}
	return &cache
}

func decodeReleaseList(body []byte) ([]ghRelease, error) {
	var releases []ghRelease
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, errf("The release list is malformed JSON: %v", err)
	}
	return releases, nil
}

// The prerelease build's feed.
func queryReleaseList(current semver) (*releaseInfo, bool, error) {
	releases, confirmed, err := fetchReleaseList()
	if err != nil {
		return nil, false, err
	}
	return pickRelease(current, releases, feedArch()), confirmed, nil
}

// The release list, and whether it was confirmed against the API this
// run rather than served from the on-disk copy.
func fetchReleaseList() ([]ghRelease, bool, error) {
	url := releaseListURL()
	path := releaseListCachePath()
	cached := readReleaseListCache(url)
	now := time.Now()
	if cached != nil && (now.Before(cached.FetchedAt.Add(releaseListMaxAge)) || now.Before(cached.RetryAt)) {
		releases, err := decodeReleaseList(cached.Body)
		return releases, false, err
	}
	req, err := newFeedRequest(url)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if cached != nil && cached.ETag != "" {
		req.Header.Set("If-None-Match", cached.ETag)
	}
	resp, err := feedClient.Do(req)
	if err != nil {
		return nil, false, errf("Couldn't reach the release list: %v", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotModified && cached != nil:
		cached.FetchedAt, cached.RetryAt = now, time.Time{}
		_ = atomicWriteJSON(path, cached)
		releases, err := decodeReleaseList(cached.Body)
		return releases, true, err
	case rateLimited(resp):
		retryAt := rateLimitReset(resp, now)
		if cached == nil {
			return nil, false, errf("GitHub is rate-limiting update checks from this address until %s.",
				retryAt.Local().Format(time.Kitchen))
		}
		cached.RetryAt = retryAt
		_ = atomicWriteJSON(path, cached)
		releases, err := decodeReleaseList(cached.Body)
		return releases, false, err
	case resp.StatusCode != http.StatusOK:
		return nil, false, errf("The release list answered HTTP %d.", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, false, errf("Couldn't read the release list: %v", err)
	}
	releases, err := decodeReleaseList(body)
	if err != nil {
		return nil, false, err
	}
	// Best-effort: a copy that fails to write only costs the next
	// check a full request.
	_ = atomicWriteJSON(path, releaseListCache{
		URL: url, FetchedAt: now, ETag: resp.Header.Get("ETag"), Body: body,
	})
	return releases, true, nil
}

// GitHub spends the hourly budget with a 403 that says so, and 429 is
// its secondary (abuse) limit. Any other 403 is a real refusal and stays
// an error.
func rateLimited(resp *http.Response) bool {
	return resp.StatusCode == http.StatusTooManyRequests ||
		(resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0")
}

// When the limit lifts: X-RateLimit-Reset (unix seconds), else
// Retry-After (seconds), else an hour. Never more than an hour out, so
// a bogus header can't park checks for a day.
func rateLimitReset(resp *http.Response, now time.Time) time.Time {
	limit := now.Add(time.Hour)
	if s, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		if t := time.Unix(s, 0); t.After(now) && t.Before(limit) {
			return t
		}
	}
	if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 && s < 3600 {
		return now.Add(time.Duration(s) * time.Second)
	}
	return limit
}

// The release a prerelease build should move to, or nil when none is
// ahead of it: the highest of the full releases and the prereleases
// in the current build's own channel that have a zip for this arch.
// A full 2.0.0 therefore beats every 2.0.0-beta.N and ends the beta
// ride. A release flagged prerelease under a full-release tag stays
// hidden, as the update server hides it. A release without the zip
// (the workflow uploads assets minutes after the tag is published) is
// skipped, as the update server skips it.
func pickRelease(current semver, releases []ghRelease, arch string) *releaseInfo {
	var best *ghRelease
	var bestVersion semver
	var bestURL string
	channel := releaseChannel(current)
	marker := "-darwin-" + arch + "-"
	for i := range releases {
		release := &releases[i]
		v, ok := parseSemver(release.TagName)
		if !ok || compareSemver(v, current) <= 0 {
			continue
		}
		if best != nil && compareSemver(v, bestVersion) <= 0 {
			continue
		}
		if v.isPrerelease() {
			if releaseChannel(v) != channel {
				continue
			}
		} else if release.Prerelease {
			continue
		}
		url := zipAssetURL(release.Assets, marker)
		if url == "" {
			continue
		}
		best, bestVersion, bestURL = release, v, url
	}
	if best == nil {
		return nil
	}
	return &releaseInfo{
		URL:         bestURL,
		Version:     strings.TrimPrefix(best.TagName, "v"),
		Notes:       best.Body,
		ReleaseDate: parseReleaseDate(best.PublishedAt),
	}
}

// The zip maker names its asset "<product>-darwin-<arch>-<version>.zip"
// (GitHub swaps the product name's spaces for dots on upload).
func zipAssetURL(assets []ghAsset, marker string) string {
	for _, asset := range assets {
		if strings.HasSuffix(asset.Name, ".zip") && strings.Contains(asset.Name, marker) {
			return asset.URL
		}
	}
	return ""
}

// The feed's pub_date passes through from GitHub. Accept the formats
// seen in the wild and fall back to "" rather than failing an update
// over a date.
func parseReleaseDate(raw string) string {
	for _, layout := range []string{time.RFC3339, time.RFC1123Z, time.RFC1123} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return ""
}

func newerThanThisBuild(v string) bool {
	current, ok := parseSemver(version)
	candidate, ok2 := parseSemver(v)
	return ok && ok2 && compareSemver(candidate, current) > 0
}

// --- installed bundle ---

// The prod CLI always runs from <bundle>/Contents/Resources/<name>
// (the PATH command is a symlink there), so the bundle to update is two
// directories up from the resolved executable. Refusing anything else
// keeps `go run` / stray copies from ever swapping /Applications.
func installedBundlePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", errf("Couldn't locate this executable: %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	resources := filepath.Dir(exe)
	contents := filepath.Dir(resources)
	bundle := filepath.Dir(contents)
	if filepath.Base(resources) != "Resources" ||
		filepath.Base(contents) != "Contents" ||
		!strings.HasSuffix(bundle, ".app") {
		return "", errf("This binary isn't running from the installed app bundle, so there is nothing to update.")
	}
	return bundle, nil
}

// --- signature verification ---

// Swappable for tests: the real implementation shells out to codesign,
// which needs an actually signed bundle.
var verifySignedUpdate = verifySignedUpdateReal

// The candidate must carry a valid (deep, strict) signature AND the
// same Team ID as the installed app. An unsigned installed bundle
// fails closed too: without an anchor to compare against, an update
// can't be trusted, and release builds are always signed.
func verifySignedUpdateReal(installedBundle, candidateBundle string) error {
	if out, err := exec.Command(
		"codesign", "--verify", "--deep", "--strict", "--", candidateBundle,
	).CombinedOutput(); err != nil {
		return errf("The downloaded update failed code-signature verification: %s",
			strings.TrimSpace(string(out)))
	}
	installedTeam, err := teamIdentifier(installedBundle)
	if err != nil {
		return err
	}
	candidateTeam, err := teamIdentifier(candidateBundle)
	if err != nil {
		return err
	}
	if installedTeam == "" {
		return errf("The installed app has no Team ID to verify the update against. Refusing to install.")
	}
	if candidateTeam != installedTeam {
		return errf("The downloaded update is signed by a different team (%s, installed app: %s). Refusing to install.",
			candidateTeam, installedTeam)
	}
	return nil
}

var teamIdentifierRe = regexp.MustCompile(`(?m)^TeamIdentifier=(.+)$`)

// "" when the bundle is signed ad-hoc (codesign prints "not set").
func teamIdentifier(bundle string) (string, error) {
	// codesign prints details on stderr, and CombinedOutput captures both.
	out, err := exec.Command("codesign", "-dvv", "--", bundle).CombinedOutput()
	if err != nil {
		return "", errf("Couldn't read the code signature of %s: %s",
			bundle, strings.TrimSpace(string(out)))
	}
	m := teamIdentifierRe.FindSubmatch(out)
	if m == nil {
		return "", errf("codesign reported no TeamIdentifier for %s.", bundle)
	}
	team := strings.TrimSpace(string(m[1]))
	if team == "not set" {
		return "", nil
	}
	return team, nil
}

// --- staging ---

// One stager at a time, across the terminal and the app's periodic
// check (which shells out to `sm update --stage` and can land mid-run).
// A pidfile rather than the state.json lock: staging holds it for the
// whole download, far past any reasonable lock timeout, and a crashed
// holder must be detectable (dead pid) instead of waited out.
// The stager's pidfile, named here so doctor and the stager can't
// disagree about which file the lock is.
func stagingLockPath() string { return filepath.Join(updatesDir(), "staging.pid") }

func acquireStagingLock() (func(), error) {
	if err := os.MkdirAll(updatesDir(), 0o755); err != nil {
		return nil, errf("Couldn't create %s: %v", updatesDir(), err)
	}
	path := stagingLockPath()
	for range 3 {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(file, "%d\n", os.Getpid())
			file.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr == nil {
			if pid, atoiErr := strconv.Atoi(strings.TrimSpace(string(raw))); atoiErr == nil && pidAlive(pid) {
				return nil, codedErrf("update-in-progress",
					"Another update is already in progress (pid %d).", pid)
			}
		}
		// Stale (dead holder) or unreadable. Claim it by rename before
		// removing: the rename succeeds for exactly one contender, so
		// two processes breaking the same stale lock can't each remove
		// the other's freshly created lock and both proceed. The loser
		// loops and finds either the winner's live lock or an empty
		// slot it loses by O_EXCL.
		stale := fmt.Sprintf("%s.stale-%d", path, os.Getpid())
		if os.Rename(path, stale) == nil {
			_ = os.Remove(stale)
		}
	}
	return nil, errf("Couldn't take the update staging lock at %s.", path)
}

func readStagedManifest() *stagedManifest {
	raw, err := os.ReadFile(stagedManifestPath())
	if err != nil {
		return nil
	}
	var man stagedManifest
	if json.Unmarshal(raw, &man) != nil || man.Version == "" || man.BundleName == "" {
		return nil
	}
	if info, err := os.Stat(stagedBundlePath(&man)); err != nil || !info.IsDir() {
		return nil
	}
	return &man
}

func clearStaged() {
	_ = os.RemoveAll(stagedDir())
}

// Debris a crashed or superseded run can leave behind. Aside bundles
// (<target>.old-*) are only pruned while the target itself exists: a
// crash between the two swap renames leaves the aside as the sole
// surviving copy of the app, and deleting it then would be deleting
// the app.
func pruneUpdateLeftovers(targetBundle string) {
	_ = os.Remove(filepath.Join(updatesDir(), "download.zip"))
	_ = os.RemoveAll(filepath.Join(updatesDir(), "extract"))
	if _, err := os.Stat(targetBundle); err != nil {
		return
	}
	dir := filepath.Dir(targetBundle)
	base := filepath.Base(targetBundle)
	for _, pattern := range []string{base + ".old-*", "." + base + ".new-*"} {
		matches, _ := filepath.Glob(filepath.Join(dir, pattern))
		for _, match := range matches {
			_ = os.RemoveAll(match)
		}
	}
}

// Check the feed and, when a release is newer than this build, leave a
// verified bundle in updates/staged. Returns (nil, nil) when already up
// to date. progress is called with (phase, version) at each slow phase
// boundary. Phases are the UpdateStageEventSchema enum
// (shared/schemas/runtime.ts); installedBundle anchors signature
// comparison.
func stageUpdate(installedBundle string, progress func(phase, version string)) (*stagedManifest, error) {
	// The lock comes first: every mutation below (pruning debris,
	// clearing the staged dir, the download/extract scratch space)
	// must be invisible to a concurrent stager, or two runs (the app's
	// periodic check and a terminal `sm update`) can delete each
	// other's in-flight files.
	unlock, err := acquireStagingLock()
	if err != nil {
		return nil, err
	}
	defer unlock()
	pruneUpdateLeftovers(installedBundle)
	release, confirmed, err := queryFeed()
	if err != nil {
		return nil, err
	}
	if release == nil {
		// Fresh boot after an install can find its own (or an older)
		// version still staged. Keeping it would offer a pointless
		// downgrade forever. Only a confirmed answer may clear it: one
		// served from the on-disk release list can lag the release an
		// earlier run staged, and that bundle stays ready.
		if confirmed {
			clearStaged()
			return nil, nil
		}
		if man := readStagedManifest(); man != nil && newerThanThisBuild(man.Version) {
			return man, nil
		}
		return nil, nil
	}
	if man := readStagedManifest(); man != nil && man.Version == release.Version {
		return man, nil
	}
	clearStaged()

	progress("downloading", release.Version)
	zipPath := filepath.Join(updatesDir(), "download.zip")
	if err := downloadFile(release.URL, zipPath); err != nil {
		return nil, err
	}
	extractDir := filepath.Join(updatesDir(), "extract")
	_ = os.RemoveAll(extractDir)
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		return nil, errf("Couldn't create %s: %v", extractDir, err)
	}
	// ditto preserves the resource forks and extended attributes the
	// signature covers. A plain unzip can silently break it.
	if out, err := exec.Command("ditto", "-x", "-k", zipPath, extractDir).CombinedOutput(); err != nil {
		return nil, errf("Couldn't extract the update: %s", strings.TrimSpace(string(out)))
	}
	_ = os.Remove(zipPath)
	bundle, err := findExtractedBundle(extractDir)
	if err != nil {
		return nil, err
	}
	// Parity with Squirrel.Mac: make sure the installed bundle never
	// carries a quarantine flag, which would translocate or
	// Gatekeeper-prompt the app on relaunch. Our download path doesn't
	// set one, but the zip's own xattr metadata is out of our hands.
	// Best-effort: quarantine is an xattr, not part of the signature.
	_ = exec.Command("xattr", "-dr", "com.apple.quarantine", bundle).Run()

	progress("verifying", release.Version)
	if err := verifySignedUpdate(installedBundle, bundle); err != nil {
		_ = os.RemoveAll(extractDir)
		return nil, err
	}
	if err := os.MkdirAll(stagedDir(), 0o755); err != nil {
		return nil, errf("Couldn't create %s: %v", stagedDir(), err)
	}
	staged := filepath.Join(stagedDir(), filepath.Base(bundle))
	if err := os.Rename(bundle, staged); err != nil {
		return nil, errf("Couldn't stage the update: %v", err)
	}
	_ = os.RemoveAll(extractDir)
	man := &stagedManifest{
		Version:     release.Version,
		BundleName:  filepath.Base(bundle),
		Notes:       release.Notes,
		ReleaseDate: release.ReleaseDate,
	}
	if err := atomicWriteJSON(stagedManifestPath(), man); err != nil {
		return nil, errf("Couldn't write the staging manifest: %v", err)
	}
	return man, nil
}

func downloadFile(url, dest string) error {
	req, err := newFeedRequest(url)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: downloadTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return errf("Couldn't download the update: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errf("Downloading the update failed with HTTP %d.", resp.StatusCode)
	}
	file, err := os.Create(dest)
	if err != nil {
		return errf("Couldn't write the update to %s: %v", dest, err)
	}
	_, copyErr := io.Copy(file, resp.Body)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(dest)
		return errf("The update download was interrupted: %v", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(dest)
		return errf("Couldn't finish writing the update: %v", closeErr)
	}
	return nil
}

// The release zip contains exactly the .app at its top level (Electron
// Forge's zip maker); scan rather than hardcode the name so a rename
// of the app doesn't strand old installs.
func findExtractedBundle(extractDir string) (string, error) {
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return "", errf("Couldn't read %s: %v", extractDir, err)
	}
	var bundles []string
	for _, entry := range entries {
		if entry.IsDir() && strings.HasSuffix(entry.Name(), ".app") {
			bundles = append(bundles, filepath.Join(extractDir, entry.Name()))
		}
	}
	if len(bundles) != 1 {
		return "", errf("The update zip contained %d app bundles instead of exactly one.", len(bundles))
	}
	return bundles[0], nil
}

// --- swap ---

// Replace targetBundle with stagedApp. Ordering makes every crash
// point recoverable:
//  1. Move (or, cross-volume, copy) the staged bundle NEXT TO the
//     target. This is the only slow step, and the target is untouched
//     if it fails.
//  2. Re-verify the signature in its final location, closing the gap
//     between stage-time verification and install.
//  3. rename(target -> aside), rename(incoming -> target): two
//     same-directory renames, each atomic. A failure of the second
//     rolls the first back. The only unrecoverable-by-code window is
//     between the two renames, microseconds wide, and even then the
//     aside bundle survives on disk.
//
// The running CLI binary may live inside targetBundle. Every step is a
// rename or unlink, never an in-place write, so its inode stays valid.
func swapBundle(stagedApp, targetBundle string) error {
	dir := filepath.Dir(targetBundle)
	base := filepath.Base(targetBundle)
	incoming := filepath.Join(dir, fmt.Sprintf(".%s.new-%d", base, os.Getpid()))
	_ = os.RemoveAll(incoming)
	if err := os.Rename(stagedApp, incoming); err != nil {
		// Different volume (the data dir and /Applications usually share
		// one, but SHIGOMORI_DATA_DIR can point anywhere): fall back to a
		// metadata-preserving copy.
		if out, dittoErr := exec.Command("ditto", stagedApp, incoming).CombinedOutput(); dittoErr != nil {
			_ = os.RemoveAll(incoming)
			return errf("Couldn't move the update next to the app: %s", strings.TrimSpace(string(out)))
		}
		_ = os.RemoveAll(stagedApp)
	}
	if err := verifySignedUpdate(targetBundle, incoming); err != nil {
		_ = os.RemoveAll(incoming)
		return err
	}
	aside := filepath.Join(dir, fmt.Sprintf("%s.old-%d", base, os.Getpid()))
	_ = os.RemoveAll(aside)
	if err := os.Rename(targetBundle, aside); err != nil {
		_ = os.RemoveAll(incoming)
		return errf("Couldn't move the old app aside: %v", err)
	}
	if err := os.Rename(incoming, targetBundle); err != nil {
		rollbackErr := os.Rename(aside, targetBundle)
		_ = os.RemoveAll(incoming)
		if rollbackErr != nil {
			return errf("Couldn't install the update (%v) and restoring the old app failed too (%v). The old app is at %s.",
				err, rollbackErr, aside)
		}
		return errf("Couldn't install the update: %v (the old app was restored)", err)
	}
	_ = os.RemoveAll(aside)
	return nil
}

// Install the staged update over targetBundle and clean up the staging
// area. Runs under the staging lock: the swap's scratch names
// (.new-*/.old-*) are exactly what pruneUpdateLeftovers sweeps, so a
// concurrent stager's prune must be kept out of the swap window. The
// staged dir is cleared even though swapBundle already moved the
// bundle out of it: the manifest and any strays must not survive a
// completed install.
func installStaged(man *stagedManifest, targetBundle string) error {
	unlock, err := acquireStagingLock()
	if err != nil {
		return err
	}
	defer unlock()
	if err := swapBundle(stagedBundlePath(man), targetBundle); err != nil {
		return err
	}
	clearStaged()
	return nil
}

// --- install log (finish-install runs headless) ---

func appendInstallLog(format string, args ...any) {
	_ = os.MkdirAll(updatesDir(), 0o755)
	file, err := os.OpenFile(filepath.Join(updatesDir(), "install.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// How long the finish-install helper waits for the quitting app to
// actually exit before giving up (a wedged quit must not leave a swap
// hanging over a live process).
const appQuitTimeout = 2 * time.Minute

func waitForPidExit(pid int) error {
	deadline := time.Now().Add(appQuitTimeout)
	for pidAlive(pid) {
		if time.Now().After(deadline) {
			return errf("Process %d is still running after %s.", pid, appQuitTimeout)
		}
		time.Sleep(pollInterval)
	}
	return nil
}
