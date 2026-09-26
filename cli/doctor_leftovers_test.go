package main

// Tests for the leftover checks (doctor_leftovers.go): update scratch
// space, and the ps parsing behind the orphaned-script check. The
// process checks themselves read the live process table, so only their
// parsing is pinned here.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestUpdateLeftovers(t *testing.T) {
	sandboxDataDir(t)
	report := &doctorReport{}
	checkUpdateLeftovers(report)
	if len(report.findings) != 0 {
		t.Fatalf("a clean updates/ needs no line: %+v", report.findings)
	}

	writeFileT(t, filepath.Join(updatesDir(), "download.zip"), strings.Repeat("x", 2048))
	writeFileT(t, filepath.Join(updatesDir(), "extract", "a"), "x")
	report = &doctorReport{}
	checkUpdateLeftovers(report)
	finding := onlyFinding(t, report, "update-leftovers", statusWarn)
	if err := finding.repair.apply(); err != nil {
		t.Fatal(err)
	}
	if pathExists(filepath.Join(updatesDir(), "download.zip")) || pathExists(filepath.Join(updatesDir(), "extract")) {
		t.Fatal("the repair left update scratch behind")
	}

	// A live stager owns its scratch space.
	writeFileT(t, filepath.Join(updatesDir(), "download.zip"), "x")
	writeFileT(t, stagingLockPath(), strconv.Itoa(os.Getpid()))
	report = &doctorReport{}
	checkUpdateLeftovers(report)
	if len(report.findings) != 0 {
		t.Fatalf("mid-update scratch was reported: %+v", report.findings)
	}
}

func TestParseProcessTable(t *testing.T) {
	table := parseProcessTable("  4242 Mon Aug 17 18:42:41 2026\nnoise\n")
	want := time.Date(2026, 8, 17, 18, 42, 41, 0, time.Local)
	if started, ok := table[4242]; !ok || !started.Equal(want) {
		t.Fatalf("got %v, want pid 4242 started %v", table, want)
	}
}
