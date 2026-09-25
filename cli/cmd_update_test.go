package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A prod CLI whose feed stand-ins can only come from flags.
func stubProdUpdate(t *testing.T) {
	t.Helper()
	stubString(t, &flavor, "prod")
	stubString(t, &version, "1.0.0")
	stubString(t, &feedURLOverride, "")
	stubString(t, &releasesURLOverride, "")
	t.Setenv("SHIGOMORI_UPDATE_FEED_URL", "")
	t.Setenv("SHIGOMORI_UPDATE_RELEASES_URL", "")
	sandboxDataDir(t)
}

func TestUpdateFeedURLFlagReachesTheFeed(t *testing.T) {
	stubProdUpdate(t)
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	code, err := cmdUpdate(cliContext{}, []string{"--check", "--feed-url", " " + server.URL + " "})
	if code != 0 || err != nil {
		t.Fatalf("code = %d, err = %v", code, err)
	}
	if hits != 1 {
		t.Fatalf("stand-in hits = %d, want 1", hits)
	}
}

func TestUpdateRefusesTheReplacedEnvironmentVariables(t *testing.T) {
	for _, name := range []string{"SHIGOMORI_UPDATE_FEED_URL", "SHIGOMORI_UPDATE_RELEASES_URL"} {
		t.Run(name, func(t *testing.T) {
			stubProdUpdate(t)
			t.Setenv(name, "http://127.0.0.1:1")
			if code, err := cmdUpdate(cliContext{}, []string{"--check"}); code != 2 || err == nil {
				t.Fatalf("code = %d, err = %v, want a usage refusal", code, err)
			}
		})
	}
}
