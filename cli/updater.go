package main

// The update engine behind `sm update` (cmd_update.go). The CLI owns
// the whole pipeline -- the app is not involved until the moment a
// running instance has to restart:
//   query    GET the update.electronjs.org feed for this repo/arch/
//            version. The server does the version comparison (204 =
//            up to date, 200 = JSON pointing at the release zip).
//   stage    download the zip under <root>/updates, extract it, verify
//            the code signature, and park the new bundle in
//            updates/staged with a manifest describing it.
//   swap     replace the installed bundle with the staged one. The
//            sequence is crash-safe by ordering: the new bundle is
//            first placed *next to* the target (the only step that can
//            be slow or cross-volume), signature-verified again in its
//            final location, and only then swapped in via two
//            same-directory renames with a rollback in between.
// Trust model: transport is HTTPS, but the anchor is Apple's code
// signature -- a staged bundle installs only if `codesign --verify`
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

func updatesDir() string { return filepath.Join(shigomoriRoot(), "updates") }
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

func feedURL() string {
	if override := strings.TrimSpace(os.Getenv("SHIGOMORI_UPDATE_FEED_URL")); override != "" {
		return override
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64" // Electron's process.arch spelling
	}
	return "https://update.electronjs.org/" + updateFeedRepo + "/darwin-" + arch + "/" + version
}

// nil, nil means "already up to date" (the server compares versions and
// answers 204). Any other non-200 answer is an error: this build's
// version is in the URL, so 404s and friends mean a broken feed, not a
// missing update.
func queryFeed() (*releaseInfo, error) {
	req, err := http.NewRequest("GET", feedURL(), nil)
	if err != nil {
		return nil, errf("Bad update feed URL: %v", err)
	}
	req.Header.Set("User-Agent", "shigoto-no-mori-cli/"+version)
	client := &http.Client{Timeout: feedTimeout}
	resp, err := client.Do(req)
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
// boundary -- phases are the UpdateStageEventSchema enum
// (shared/schemas/runtime.ts); installedBundle anchors signature
// comparison.
func stageUpdate(installedBundle string, progress func(phase, version string)) (*stagedManifest, error) {
	// The lock comes first: every mutation below -- pruning debris,
	// clearing the staged dir, the download/extract scratch space --
	// must be invisible to a concurrent stager, or two runs (the app's
	// periodic check and a terminal `sm update`) can delete each
	// other's in-flight files.
	unlock, err := acquireStagingLock()
	if err != nil {
		return nil, err
	}
	defer unlock()
	pruneUpdateLeftovers(installedBundle)
	release, err := queryFeed()
	if err != nil {
		return nil, err
	}
	if release == nil {
		// Fresh boot after an install can find its own (or an older)
		// version still staged. Keeping it would offer a pointless
		// downgrade forever.
		clearStaged()
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
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return errf("Bad release URL: %v", err)
	}
	req.Header.Set("User-Agent", "shigoto-no-mori-cli/"+version)
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
//     target -- the only slow step, and the target is untouched if it
//     fails.
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
		// Different volume (state root and /Applications usually share
		// one, but SHIGOMORI_ROOT can point anywhere): fall back to a
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
			return errf("Couldn't install the update (%v) and restoring the old app failed too (%v) -- the old app is at %s.",
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
