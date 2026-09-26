package main

// The read verbs the app uses instead of opening the data dir's files
// itself: sm launchers --json, sm run --json (the list form),
// config read / projects config read.

import (
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestLaunchersJSON(t *testing.T) {
	proj := autoPullSandbox(t)
	writeFileT(t, configJSONPath(), `{"launchers":[`+
		`{"id":"a1","label":"Zed tool","command":"true"},`+
		`{"id":"b2","label":"Hidden tool","command":"true"}],`+
		`"hiddenLaunchers":["custom:b2"]}`)
	seedState(t, fmt.Sprintf(`{"launcherUseLog":{"custom:a1":[%d]}}`, time.Now().UnixMilli()))

	ctx := cliContext{projects: []project{proj}}
	docs := captureJSON(t, func() {
		if code, err := cmdLaunchers(ctx, []string{"--project-id", proj.ID}); code != 0 || err != nil {
			t.Fatalf("launchers: %d, %v", code, err)
		}
	})
	doc := decodeT[struct {
		OK          bool               `json:"ok"`
		Entries     []map[string]any   `json:"entries"`
		HiddenCount int                `json:"hiddenCount"`
		Usage       map[string]useStat `json:"usage"`
	}](t, onlyDoc(t, docs))
	if !doc.OK || doc.HiddenCount != 1 || len(doc.Entries) == 0 {
		t.Fatalf("launchers = %+v", doc)
	}
	// Most used first; custom entries carry no available flag.
	first := doc.Entries[0]
	if first["id"] != "custom:a1" || first["kind"] != "custom" || first["label"] != "Zed tool" {
		t.Errorf("first entry = %v, want the used custom launcher", first)
	}
	if _, has := first["available"]; has {
		t.Errorf("a custom entry carries available: %v", first)
	}
	// Finder is always there, as a detected tool that is available.
	finder := slices.IndexFunc(doc.Entries, func(e map[string]any) bool { return e["id"] == "app:finder" })
	if finder < 0 || doc.Entries[finder]["kind"] != "detected" || doc.Entries[finder]["available"] != true {
		t.Errorf("finder entry missing or malformed: %v", doc.Entries)
	}
	if slices.IndexFunc(doc.Entries, func(e map[string]any) bool { return e["id"] == "custom:b2" }) >= 0 {
		t.Error("a hidden launcher was listed")
	}
	if doc.Usage["custom:a1"].RecentCount != 1 || doc.Usage["app:finder"].RecentCount != 0 {
		t.Errorf("usage = %+v", doc.Usage)
	}
}

func TestRunListJSON(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	writeFileT(t, filepath.Join(wt.Path, "package.json"), `{"scripts":{"dev":"vite","build":"vite build"}}`)
	writeFileT(t, filepath.Join(wt.Path, "pnpm-lock.yaml"), "")
	now := time.Now().UnixMilli()
	seedState(t, fmt.Sprintf(`{"packageScriptUseLog":{%q:{"dev":[%d,%d]}},`+
		`"packageScriptSort":{%q:"manual"},"packageScriptOrder":{%q:["build","dev"]}}`,
		proj.ID, now-5, now, proj.ID, proj.ID))

	ctx := cliContext{projects: []project{proj}}
	list := func(worktreeID string) map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdRun(ctx, []string{"--project-id", proj.ID, "--worktree-id", worktreeID}); code != 0 || err != nil {
				t.Fatalf("run --json: %d, %v", code, err)
			}
		})
		return decodeT[map[string]any](t, onlyDoc(t, docs))
	}
	doc := list(wt.ID)
	want := map[string]any{
		"ok":             true,
		"packageManager": "pnpm",
		"scripts": []any{
			map[string]any{"name": "dev", "command": "vite"},
			map[string]any{"name": "build", "command": "vite build"},
		},
		"usage": map[string]any{
			"dev":   map[string]any{"lastUsed": float64(now), "recentCount": float64(2)},
			"build": map[string]any{"lastUsed": float64(0), "recentCount": float64(0)},
		},
		"sort":  "manual",
		"order": []any{"build", "dev"},
	}
	if !reflect.DeepEqual(doc, want) {
		t.Errorf("run --json =\n%v\nwant\n%v", doc, want)
	}

	// Another project's saved sort is none of this one's: the defaults.
	seedState(t, `{}`)
	doc = list(wt.ID)
	if doc["sort"] != "frequent" || !reflect.DeepEqual(doc["order"], []any{}) {
		t.Errorf("defaults: sort %v order %v, want frequent and []", doc["sort"], doc["order"])
	}

	// No package.json is a coded failure the panel reads as "no scripts".
	primaryID := worktreeIDFromPath(proj.Path)
	captureJSON(t, func() {
		if _, err := cmdRun(ctx, []string{"--worktree-id", primaryID}); errorKindOf(err) != "no-package-json" {
			t.Errorf("no package.json: %v (kind %q), want no-package-json", err, errorKindOf(err))
		}
	})
}

func TestConfigRead(t *testing.T) {
	sandboxDataDir(t)
	read := func(scope configDocScope) map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := runConfigRead(scope); code != 0 || err != nil {
				t.Fatalf("read: %d, %v", code, err)
			}
		})
		return decodeT[map[string]any](t, onlyDoc(t, docs))
	}
	if doc := read(globalConfigScope()); !reflect.DeepEqual(doc["config"], map[string]any{}) {
		t.Errorf("missing config.json read as %v, want {}", doc["config"])
	}
	// As stored: unknown keys kept, no defaults filled in.
	writeFileT(t, configJSONPath(), `{"portPool":true,"directConnections":false,"futureKey":{"x":1}}`)
	want := map[string]any{"portPool": true, "directConnections": false, "futureKey": map[string]any{"x": float64(1)}}
	if doc := read(globalConfigScope()); !reflect.DeepEqual(doc["config"], want) {
		t.Errorf("config read = %v, want %v", doc["config"], want)
	}

	proj := testProject(t)
	scope := projectConfigScope(proj)
	if doc := read(scope); doc["config"] != nil || doc["project"] != proj.Name {
		t.Errorf("missing project.json read as %v", doc)
	}
	writeFileT(t, scope.path, `{"defaultBranch":"main","scripts":{"setup":"pnpm i"}}`)
	if doc := read(scope); !reflect.DeepEqual(doc["config"],
		map[string]any{"defaultBranch": "main", "scripts": map[string]any{"setup": "pnpm i"}}) {
		t.Errorf("project config read = %v", doc["config"])
	}

	// Broken is an error, never a quiet {}.
	writeFileT(t, configJSONPath(), `{"portPool":`)
	captureJSON(t, func() {
		if code, err := runConfigRead(globalConfigScope()); code == 0 || err == nil {
			t.Errorf("malformed config.json read = %d, %v, want an error", code, err)
		}
	})
}
