package main

import (
	"reflect"
	"testing"
)

func TestParseCmdArgsDoubleDash(t *testing.T) {
	spec := argSpec{strings: map[string][]string{"flag": {}}}
	parsed, err := parseCmdArgs(
		[]string{"a", "--flag", "v", "--", "--not-a-flag", "b"}, spec)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.strings["flag"] != "v" {
		t.Errorf("flag = %q, want v", parsed.strings["flag"])
	}
	want := []string{"a", "--not-a-flag", "b"}
	if !reflect.DeepEqual(parsed.positionals, want) {
		t.Errorf("positionals = %v, want %v", parsed.positionals, want)
	}
}

func TestParseCmdArgsDoubleDashOnly(t *testing.T) {
	parsed, err := parseCmdArgs([]string{"--"}, argSpec{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed.positionals) != 0 {
		t.Errorf("positionals = %v, want none", parsed.positionals)
	}
}
