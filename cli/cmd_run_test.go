package main

// Tests for the sm run plumbing that doesn't need a repo: manifest
// parsing (order, non-string filtering) and manager argv construction.

import (
	"reflect"
	"testing"
)

func TestParsePackageScriptsKeepsManifestOrder(t *testing.T) {
	raw := []byte(`{
		"name": "x",
		"scripts": {
			"zeta": "run z",
			"alpha": "run a",
			"mid": "run m"
		}
	}`)
	scripts, err := parsePackageScripts(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []packageScript{
		{Name: "zeta", Command: "run z"},
		{Name: "alpha", Command: "run a"},
		{Name: "mid", Command: "run m"},
	}
	if !reflect.DeepEqual(scripts, want) {
		t.Fatalf("got %v, want %v", scripts, want)
	}
}

func TestParsePackageScriptsDropsNonStrings(t *testing.T) {
	raw := []byte(`{"scripts": {"ok": "x", "num": 3, "obj": {"a": 1}, "arr": [1], "ok2": "y"}}`)
	scripts, err := parsePackageScripts(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []packageScript{{Name: "ok", Command: "x"}, {Name: "ok2", Command: "y"}}
	if !reflect.DeepEqual(scripts, want) {
		t.Fatalf("got %v, want %v", scripts, want)
	}
}

func TestParsePackageScriptsToleratesMissingOrWrongShape(t *testing.T) {
	for _, raw := range []string{`{}`, `{"scripts": []}`, `{"scripts": "x"}`, `{"scripts": null}`} {
		scripts, err := parsePackageScripts([]byte(raw))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", raw, err)
		}
		if len(scripts) != 0 {
			t.Fatalf("%s: expected no scripts, got %v", raw, scripts)
		}
	}
	if _, err := parsePackageScripts([]byte(`not json`)); err == nil {
		t.Fatal("invalid JSON should error")
	}
}

func TestRunArgv(t *testing.T) {
	cases := []struct {
		manager string
		extra   []string
		want    []string
	}{
		{"pnpm", nil, []string{"pnpm", "run", "dev"}},
		{"pnpm", []string{"--port", "3000"}, []string{"pnpm", "run", "dev", "--port", "3000"}},
		{"npm", []string{"--port", "3000"}, []string{"npm", "run", "dev", "--", "--port", "3000"}},
		{"npm", nil, []string{"npm", "run", "dev"}},
		{"bun", []string{"file.ts"}, []string{"bun", "run", "dev", "file.ts"}},
	}
	for _, c := range cases {
		if got := runArgv(c.manager, "dev", c.extra); !reflect.DeepEqual(got, c.want) {
			t.Errorf("runArgv(%s, dev, %v) = %v, want %v", c.manager, c.extra, got, c.want)
		}
	}
}
