package main

import (
	"reflect"
	"testing"
)

func TestParseStatusPaths(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		want   []string
	}{
		{"clean", "", nil},
		{"modified and untracked", " M a.txt\x00?? b.txt\x00", []string{"a.txt", "b.txt"}},
		// Staged rename: R in the index column, source in the next field.
		{"staged rename", "R  new.txt\x00old.txt\x00", []string{"new.txt"}},
		// Unstaged rename (git detects these too, e.g. after `git add -N`):
		// R in the WORKTREE column, and it emits a source field all the same.
		{"unstaged rename", " R third.txt\x00new.txt\x00", []string{"third.txt"}},
		{"copy", "C  copy.txt\x00src.txt\x00", []string{"copy.txt"}},
		{"rename then more", " R b.txt\x00a.txt\x00 M c.txt\x00", []string{"b.txt", "c.txt"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseStatusPaths(tc.stdout); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseStatusPaths(%q) = %v, want %v", tc.stdout, got, tc.want)
			}
		})
	}
}
