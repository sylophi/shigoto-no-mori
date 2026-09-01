package main

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestCatchUpApplies(t *testing.T) {
	cases := []struct {
		name        string
		prBase      string
		primary     string
		wantApplies bool
		wantSkip    string
	}{
		{"base is the primary branch", "main", "main", true, ""},
		// The bug this guards: a PR based on a long-lived branch merged
		// nothing into main, so pulling main claims a catch-up that did
		// not happen and drags in unrelated commits.
		{
			"base is a feature line",
			"v2", "main", false,
			"PR merged into v2, not the primary branch main",
		},
		{
			"primary branch is not named main",
			"main", "trunk", false,
			"PR merged into main, not the primary branch trunk",
		},
		// An unreadable base keeps the old behavior rather than
		// skipping, since the default base is the common case.
		{"base unknown", "", "main", true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			applies, skip := catchUpApplies(tc.prBase, tc.primary)
			if applies != tc.wantApplies {
				t.Errorf("catchUpApplies(%q, %q) applies = %v, want %v",
					tc.prBase, tc.primary, applies, tc.wantApplies)
			}
			if skip != tc.wantSkip {
				t.Errorf("catchUpApplies(%q, %q) skip = %q, want %q",
					tc.prBase, tc.primary, skip, tc.wantSkip)
			}
		})
	}
}

// The base ref has to survive the gh lookup, or land falls back to the
// unknown-base path and the guard above never fires in practice.
func TestPrLookupArgsRequestsBaseRefName(t *testing.T) {
	args := prLookupArgs("some-branch")
	var fields string
	for i, a := range args {
		if a == "--json" && i+1 < len(args) {
			fields = args[i+1]
		}
	}
	if fields == "" {
		t.Fatalf("prLookupArgs produced no --json field list: %v", args)
	}
	if !slices.Contains(strings.Split(fields, ","), "baseRefName") {
		t.Errorf("prLookupArgs --json fields = %q, want baseRefName among them", fields)
	}
}

// Verbatim `gh pr list` output for the field list above, so a struct
// tag that stops matching gh's spelling fails here instead of silently
// leaving every base empty and re-enabling the false catch-up.
func TestPrSummaryDecodesBaseRefName(t *testing.T) {
	const ghOutput = `[{"baseRefName":"v2","isDraft":false,"number":249,` +
		`"state":"MERGED","title":"Reword device revoke",` +
		`"url":"https://github.com/o/r/pull/249"}]`
	var prs []prSummary
	if err := json.Unmarshal([]byte(ghOutput), &prs); err != nil {
		t.Fatalf("decoding gh output: %v", err)
	}
	if len(prs) != 1 {
		t.Fatalf("decoded %d pull requests, want 1", len(prs))
	}
	if prs[0].BaseRefName != "v2" {
		t.Errorf("BaseRefName = %q, want %q", prs[0].BaseRefName, "v2")
	}
}
