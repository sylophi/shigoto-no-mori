package main

// Live-signing rehearsal, driven by env vars and skipped otherwise.
// Unlike updater_test.go it does NOT stub signature verification: it
// runs the full stage + install pipeline against a real
// Developer-ID-signed bundle copy and a local feed, so the real
// codesign checks and the swap are exercised end to end. Setup (all
// paths disposable copies, the installed app is never touched):
//   1. ditto --noextattr --noacl "/Applications/Shigoto no Mori.app"
//      into a scratch dir. This is SM_LIVE_BUNDLE, the swap target.
//   2. Zip a second pristine copy (ditto -c -k) as the "release", and
//      a third copy with any file modified as the tampered release.
//   3. Serve both zips plus two Squirrel-style feed documents
//      ({"url": ..., "name": "v99.9.9"}) over local HTTP. Those feed
//      URLs are SM_LIVE_FEED_GOOD and SM_LIVE_FEED_BAD.

import (
	"os"
	"strings"
	"testing"
)

func TestLiveSignedPipeline(t *testing.T) {
	bundle := os.Getenv("SM_LIVE_BUNDLE")
	goodFeed := os.Getenv("SM_LIVE_FEED_GOOD")
	badFeed := os.Getenv("SM_LIVE_FEED_BAD")
	if bundle == "" || goodFeed == "" || badFeed == "" {
		t.Skip("SM_LIVE_* env not set")
	}
	sandboxRoot(t)

	// Tampered release: real codesign must fail it closed, and nothing
	// may be staged.
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", badFeed)
	if _, err := stageUpdate(bundle, func(string, string) {}); err == nil {
		t.Fatal("tampered bundle passed signature verification")
	} else if !strings.Contains(err.Error(), "signature") {
		t.Fatalf("unexpected error for tampered bundle: %v", err)
	}
	if readStagedManifest() != nil {
		t.Fatal("tampered bundle was staged")
	}

	// Genuine release: stage with real verification, then install over
	// the target copy.
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", goodFeed)
	man, err := stageUpdate(bundle, func(phase, v string) { t.Logf("%s %s", phase, v) })
	if err != nil {
		t.Fatal(err)
	}
	if man == nil || man.Version != "99.9.9" {
		t.Fatalf("unexpected manifest: %+v", man)
	}
	if err := installStaged(man, bundle); err != nil {
		t.Fatal(err)
	}
	// The swapped-in bundle must still be validly signed with a team.
	team, err := teamIdentifier(bundle)
	if err != nil || team == "" {
		t.Fatalf("swapped bundle team = %q, err %v", team, err)
	}
	if readStagedManifest() != nil {
		t.Fatal("staging area not cleaned after install")
	}
	t.Logf("installed %s over target, team %s", man.Version, team)
}
