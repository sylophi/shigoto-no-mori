package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditOpensTheFileInTheChosenEditor(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}
	file := filepath.Join(fox.Path, "src", "a.txt")
	writeFileT(t, file, "a\n")
	// Ahead of the real PATH, which git is on.
	path := os.Getenv("PATH")
	bin := fakeBin(t, "open", "zed")
	t.Setenv("PATH", bin+":"+path)

	edit := func(rel string) (int, error) {
		var code int
		var err error
		captureJSON(t, func() {
			code, err = cmdEdit(ctx, []string{"--project-id", proj.ID, "--worktree-id", fox.ID, "--", rel})
		})
		return code, err
	}
	calledWith := func(name string) string {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(bin, name+".args"))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSuffix(string(raw), "\n")
	}

	// Unset, the file's default app.
	if code, err := edit("src/a.txt"); code != 0 || err != nil {
		t.Fatalf("edit = %d, %v", code, err)
	}
	if got := calledWith("open"); got != file {
		t.Errorf("open got %q, want %q", got, file)
	}

	// An executable's default app would run it.
	if err := os.Chmod(file, 0o755); err != nil {
		t.Fatal(err)
	}
	if code, err := edit("src/a.txt"); code != 0 || err != nil {
		t.Fatalf("edit = %d, %v", code, err)
	}
	if got, want := calledWith("open"), "-t\n"+file; got != want {
		t.Errorf("open got %q, want %q", got, want)
	}

	// A tool that isn't an editor isn't one here either.
	writeFileT(t, configJSONPath(), `{"editor":"lazygit"}`)
	if code, err := edit("src/a.txt"); code != 0 || err != nil {
		t.Fatalf("edit = %d, %v", code, err)
	}
	if got, want := calledWith("open"), "-t\n"+file; got != want {
		t.Errorf("open got %q, want %q", got, want)
	}

	// An editor with a command takes the worktree along.
	writeFileT(t, configJSONPath(), `{"editor":"zed"}`)
	if code, err := edit("src/a.txt"); code != 0 || err != nil {
		t.Fatalf("edit = %d, %v", code, err)
	}
	if got, want := calledWith("zed"), fox.Path+"\n"+file; got != want {
		t.Errorf("zed got %q, want %q", got, want)
	}

	if code, _ := edit("src"); code != 1 {
		t.Errorf("a folder = exit %d, want 1", code)
	}
	if _, err := edit("src/gone.txt"); errorKindOf(err) != "missing-file" {
		t.Errorf("missing file: %v", err)
	}
}

func TestEditorKeyTakesOnlyEditors(t *testing.T) {
	key, err := lookupConfigKey(globalConfigKeys, "editor")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseConfigValue(key, "zed"); err != nil {
		t.Errorf("zed: %v", err)
	}
	if _, err := parseConfigValue(key, "lazygit"); err == nil {
		t.Error("lazygit took as an editor")
	}
}
