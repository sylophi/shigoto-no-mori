package main

import (
	"encoding/json"
	"slices"
	"testing"
)

func stackFixture() []prSummary {
	// Newest first, as gh lists them. #5 is a second PR over layer-a's
	// old head branch name, so #1 must lose to it when heads collide.
	return []prSummary{
		{Number: 6, State: "OPEN", HeadRefName: "hotfix", BaseRefName: "main"},
		{Number: 4, State: "OPEN", HeadRefName: "layer-c", BaseRefName: "layer-b"},
		{Number: 3, State: "OPEN", IsDraft: true, HeadRefName: "layer-b", BaseRefName: "layer-a"},
		{Number: 2, State: "MERGED", HeadRefName: "layer-a", BaseRefName: "main"},
		{Number: 7, State: "OPEN", HeadRefName: "main", BaseRefName: "production"},
	}
}

func numbersOf(prs []prSummary) []int {
	out := make([]int, len(prs))
	for i, pr := range prs {
		out[i] = pr.Number
	}
	return out
}

// The chain runs from the bottom up to the asked PR, through a merged
// bottom, and never into the trunk: the "main -> production" PR #7
// would otherwise sit under every stack.
func TestStackBelowWalksToTheTrunk(t *testing.T) {
	chain := stackBelow(stackFixture(), 4, "main")
	if got, want := numbersOf(chain), []int{2, 3, 4}; !slices.Equal(got, want) {
		t.Errorf("stackBelow(4) = %v, want %v", got, want)
	}
	if chain[0].BaseRefName != "main" {
		t.Errorf("bottom base = %q, want main", chain[0].BaseRefName)
	}
	if got := numbersOf(stackBelow(stackFixture(), 6, "main")); !slices.Equal(got, []int{6}) {
		t.Errorf("stackBelow(6) = %v, want just #6", got)
	}
	if stackBelow(stackFixture(), 99, "main") != nil {
		t.Error("stackBelow(99) found a chain for a PR that doesn't exist")
	}
}

// Without the trunk guard the promotion PR is a parent; with a cycle
// in stale rows the walk still ends.
func TestStackBelowIsBounded(t *testing.T) {
	prs := []prSummary{
		{Number: 1, State: "OPEN", HeadRefName: "a", BaseRefName: "b"},
		{Number: 2, State: "OPEN", HeadRefName: "b", BaseRefName: "a"},
	}
	if got := numbersOf(stackBelow(prs, 1, "main")); !slices.Equal(got, []int{2, 1}) {
		t.Errorf("stackBelow on a cycle = %v, want [2 1]", got)
	}
	if got := numbersOf(stackBelow(stackFixture(), 6, "")); !slices.Equal(got, []int{7, 6}) {
		t.Errorf("stackBelow without a trunk = %v, want the promotion PR under #6", got)
	}
}

// Merged PRs drop out of the set, a draft refuses before anything
// lands, a closed PR under the top breaks the stack.
func TestStackMergeSet(t *testing.T) {
	chain := stackBelow(stackFixture(), 4, "main")
	if _, err := stackMergeSet(chain); err == nil {
		t.Error("a draft in the stack merged")
	}
	chain[1].IsDraft = false
	set, err := stackMergeSet(chain)
	if err != nil {
		t.Fatalf("stackMergeSet: %v", err)
	}
	if got, want := numbersOf(set), []int{3, 4}; !slices.Equal(got, want) {
		t.Errorf("merge set = %v, want %v", got, want)
	}
	chain[1].State = "CLOSED"
	if _, err := stackMergeSet(chain); err == nil {
		t.Error("a closed PR under the top merged")
	}
	if _, err := stackMergeSet([]prSummary{{Number: 1, State: "MERGED"}}); err == nil {
		t.Error("an all-merged stack reported something to merge")
	}
}

// Verbatim `GET /repos/{owner}/{repo}/stacks?pull_request=N` output.
func TestGithubStackDecodes(t *testing.T) {
	const body = `[{"id":1,"number":7,"url":"https://api.github.com/repos/o/r/stacks/7",` +
		`"base":{"ref":"main"},"open":true,"created_at":"2026-09-24T01:05:43Z",` +
		`"pull_requests":[{"number":4,"state":"closed","draft":false,"merged_at":"2026-09-24T01:07:49Z","head":{"ref":"layer-d","sha":"a3"}},` +
		`{"number":6,"state":"open","draft":false,"merged_at":null,"head":{"ref":"layer-f","sha":"69"}}]}]`
	var stacks []githubStack
	if err := json.Unmarshal([]byte(body), &stacks); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if len(stacks) != 1 || !stacks[0].contains(6) || stacks[0].contains(5) {
		t.Errorf("decoded %+v", stacks)
	}
	if lowest, ok := stacks[0].lowestOpen(); !ok || lowest != 6 {
		t.Errorf("lowestOpen = %d, %v, want 6 (the merged #4 is closed)", lowest, ok)
	}
	const ticket = `{"status":"pending","details":{"message":"Merge request enqueued.","uuid":"ffcc","merge_method":"squash"}}`
	var m asyncMerge
	if err := json.Unmarshal([]byte(ticket), &m); err != nil || m.Status != "pending" || m.Details.UUID != "ffcc" {
		t.Errorf("asyncMerge decoded %+v (%v)", m, err)
	}
}

// A merged bottom older than the listing's page is still the bottom:
// the walk continues by lookup until the trunk, so the sequential
// merge retargets at main rather than at the landed branch.
func TestExtendBelowReachesTheTrunk(t *testing.T) {
	chain := stackBelow(stackFixture(), 4, "main")[1:] // as if #2 fell off the page
	if chain[0].BaseRefName != "layer-a" {
		t.Fatalf("fixture: chain bottom base = %q", chain[0].BaseRefName)
	}
	looked := []string{}
	extended, err := extendBelow(chain, "main", func(branch string) (*prSummary, error) {
		looked = append(looked, branch)
		if branch == "layer-a" {
			return &prSummary{Number: 2, State: "MERGED", HeadRefName: "layer-a", BaseRefName: "main"}, nil
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := numbersOf(extended), []int{2, 3, 4}; !slices.Equal(got, want) {
		t.Errorf("extended chain = %v, want %v", got, want)
	}
	if !slices.Equal(looked, []string{"layer-a"}) {
		t.Errorf("looked up %v, want just the missing layer", looked)
	}
	// A bottom whose base has no PR is the bottom: one lookup, no change.
	orphan := []prSummary{{Number: 9, State: "OPEN", HeadRefName: "x", BaseRefName: "release"}}
	extended, err = extendBelow(orphan, "main", func(string) (*prSummary, error) { return nil, nil })
	if err != nil || len(extended) != 1 {
		t.Errorf("orphan chain = %v (%v), want unchanged", numbersOf(extended), err)
	}
}
