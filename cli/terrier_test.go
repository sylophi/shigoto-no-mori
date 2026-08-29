package main

import (
	"reflect"
	"testing"
)

// Pinned vector shared with the TS engine: terrierProjectId in
// host/lib/terrier.ts must mint this exact id for this exact path. A
// drift here means the app and the CLI address the same terrier
// project by two different ids, orphaning per-project state between
// them -- so never "fix" the expectation to match a changed
// implementation without changing both engines together.
func TestTerrierProjectIDVector(t *testing.T) {
	got := terrierProjectID("/tmp/repo")
	want := "B6FE87A9-B936-BEA6-5048-1980F473639B"
	if got != want {
		t.Errorf("terrierProjectID(/tmp/repo) = %s, want %s", got, want)
	}
	if again := terrierProjectID("/tmp/repo"); again != got {
		t.Errorf("terrierProjectID isn't deterministic: %s then %s", got, again)
	}
}

func TestAppendTerrierProjects(t *testing.T) {
	registry := []project{
		{ID: "AAAA", Name: "zeta", Path: "/repos/zeta"},
		{ID: "BBBB", Name: "both", Path: "/repos/both"},
	}
	listings := []terrierListing{
		{Path: "/repos/both"},      // registry wins: no duplicate row
		{Path: "/elsewhere/bravo"}, // extra, sorts before delta
		{Path: "/repos/delta"},     // extra
		{Path: "/elsewhere/bravo"}, // duplicate listing folds away
		{Path: ""},                 // ignored
	}

	merged := appendTerrierProjects(registry, listings)

	want := []project{
		registry[0],
		registry[1],
		{ID: terrierProjectID("/elsewhere/bravo"), Name: "bravo", Path: "/elsewhere/bravo", Source: "terrier"},
		{ID: terrierProjectID("/repos/delta"), Name: "delta", Path: "/repos/delta", Source: "terrier"},
	}
	if !reflect.DeepEqual(merged, want) {
		t.Errorf("appendTerrierProjects = %+v, want %+v", merged, want)
	}
}

func TestAppendTerrierProjectsNoListings(t *testing.T) {
	registry := []project{{ID: "AAAA", Name: "only", Path: "/repos/only"}}
	if merged := appendTerrierProjects(registry, nil); !reflect.DeepEqual(merged, registry) {
		t.Errorf("appendTerrierProjects with no listings = %+v, want the registry untouched", merged)
	}
}
