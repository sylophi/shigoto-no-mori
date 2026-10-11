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

func TestParseJustfile(t *testing.T) {
	raw := `set shell := ["bash", "-c"]
version := "1.0"
alias b := build

# Builds it
build target="all":
    @echo building {{target}}
    go build ./...

[private]
helper:
    echo hidden

_also-hidden:
    echo hidden

[group('ci')]
test: build
@quiet:
	-echo quiet
build:
    echo duplicate
`
	want := []packageScript{
		{Name: "just build", Command: "echo building {{target}}; go build ./...", runner: "just", target: "build"},
		{Name: "just test", Command: "build", runner: "just", target: "test"},
		{Name: "just quiet", Command: "echo quiet", runner: "just", target: "quiet"},
	}
	if got := parseJustfile(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseMakefile(t *testing.T) {
	raw := "CC := gcc\n" +
		"FLAGS = -a:b\n" +
		".PHONY: build test\n" +
		"\n" +
		"build: deps\n" +
		"\t@echo building\n" +
		"\t# a comment line\n" +
		"\tgo build \\\n" +
		"\t  ./...\n" +
		"\n" +
		"test: build ; go test ./...\n" +
		"lint fmt:\n" +
		"\t-golangci-lint run\n" +
		"main.o: main.c\n" +
		"\t$(CC) -c main.c\n" +
		"%.o: %.c\n" +
		"\t$(CC) -c $<\n" +
		"debug: FLAGS += -g\n" +
		"deps:\n" +
		"define TEMPLATE\n" +
		"inside: rule\n" +
		"endef\n" +
		"deps:\n" +
		"\tgo mod download\n"
	want := []packageScript{
		{Name: "make build", Command: "echo building; go build ./...", runner: "make", target: "build"},
		{Name: "make test", Command: "go test ./...", runner: "make", target: "test"},
		{Name: "make lint", Command: "golangci-lint run", runner: "make", target: "lint"},
		{Name: "make fmt", Command: "golangci-lint run", runner: "make", target: "fmt"},
		{Name: "make deps", Command: "go mod download", runner: "make", target: "deps"},
	}
	if got := parseMakefile(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestFindScript(t *testing.T) {
	scripts := []packageScript{
		{Name: "build", Command: "vite build"},
		{Name: "just build", runner: "just", target: "build"},
		{Name: "make test", runner: "make", target: "test"},
	}
	cases := []struct {
		positionals []string
		want        string
		extra       []string
	}{
		{[]string{"build", "--watch"}, "build", []string{"--watch"}},
		{[]string{"just build"}, "just build", []string{}},
		{[]string{"just", "build", "x"}, "just build", []string{"x"}},
		{[]string{"make", "test"}, "make test", []string{}},
	}
	for _, c := range cases {
		got, extra, ok := findScript(scripts, c.positionals)
		if !ok || got.Name != c.want || !reflect.DeepEqual(extra, c.extra) {
			t.Errorf("findScript(%v) = %q %v %v, want %q %v", c.positionals, got.Name, extra, ok, c.want, c.extra)
		}
	}
	if _, _, ok := findScript(scripts, []string{"make", "nope"}); ok {
		t.Error("an unknown target should not be found")
	}
}
