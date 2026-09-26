package main

// The verbs and flags the app reads through instead of keeping its own
// copies: list --identities, the primary-checkout rule, projects
// reorder, worktrees destination / rekey, id-addressed open, launchers
// --catalog, and run's list form. Against real git in a temp
// SHIGOMORI_DATA_DIR.

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// --- list --identities ---

func listIdentitiesT(t *testing.T, ctx cliContext, args ...string) []map[string]any {
	t.Helper()
	docs := captureJSON(t, func() {
		if code, err := cmdList(ctx, append([]string{"--identities"}, args...)); code != 0 || err != nil {
			t.Fatalf("list --identities %v: %d, %v", args, code, err)
		}
	})
	return decodeT[[]map[string]any](t, onlyDoc(t, docs))
}

func TestListIdentities(t *testing.T) {
	proj := projectWithOrigin(t)
	fox := createViaCmd(t, proj, "fox")
	primaryID := worktreeIDFromPath(proj.Path)
	if err := setShelved(fox.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := setRegistryMark(autoPullKey, primaryID, true); err != nil {
		t.Fatal(err)
	}
	ctx := cliContext{projects: []project{proj}}

	entries := listIdentitiesT(t, ctx, "--project-id", proj.ID)
	if len(entries) != 2 || entries[0]["id"] != primaryID || entries[1]["id"] != fox.ID {
		t.Fatalf("identities = %v, want the primary then fox", entries)
	}
	wantKeys := []string{"autoPull", "branch", "detached", "id", "isExternal", "isPrimary", "name", "path", "projectId", "shelved"}
	for _, entry := range entries {
		var keys []string
		for key := range entry {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		if !slices.Equal(keys, wantKeys) {
			t.Errorf("entry keys = %v, want %v", keys, wantKeys)
		}
	}
	primary, wt := entries[0], entries[1]
	if primary["isPrimary"] != true || primary["autoPull"] != true || primary["shelved"] != false {
		t.Errorf("primary = %v", primary)
	}
	if wt["isPrimary"] != false || wt["shelved"] != true || wt["autoPull"] != false ||
		wt["name"] != "fox" || wt["branch"] != "fox" || wt["path"] != fox.Path || wt["projectId"] != proj.ID {
		t.Errorf("fox = %v", wt)
	}

	// The same identity fields as the full rows.
	docs := captureJSON(t, func() {
		if code, err := cmdList(ctx, []string{"--project-id", proj.ID}); code != 0 || err != nil {
			t.Fatalf("list: %d, %v", code, err)
		}
	})
	for i, row := range decodeT[[]worktreeJSON](t, onlyDoc(t, docs)) {
		entry := entries[i]
		if entry["id"] != row.ID || entry["name"] != row.Name || entry["branch"] != row.Branch ||
			entry["isExternal"] != row.IsExternal || entry["shelved"] != row.Shelved || entry["autoPull"] != row.AutoPull {
			t.Errorf("identity %v disagrees with row %+v", entry, row)
		}
	}

	// --primary-ref adds the project's primary ref to every entry.
	for _, entry := range listIdentitiesT(t, ctx, "--project-id", proj.ID, "--primary-ref") {
		if entry["primaryRef"] != "origin/main" || entry["primaryBranch"] != "main" {
			t.Errorf("--primary-ref entry = %v", entry)
		}
	}

	// --worktree-id narrows to one, -p works like the full list.
	one := listIdentitiesT(t, ctx, "--project-id", proj.ID, "--worktree-id", fox.ID, "--primary-ref")
	if len(one) != 1 || one[0]["id"] != fox.ID || one[0]["primaryBranch"] != "main" {
		t.Fatalf("--worktree-id = %v", one)
	}
	if got := listIdentitiesT(t, ctx, "-p", proj.Path); len(got) != 2 {
		t.Errorf("-p = %v", got)
	}
	if _, err := cmdList(ctx, []string{"--identities", "--worktree-id", "gone"}); errorKindOf(err) != "unknown-worktree" {
		t.Errorf("unknown --worktree-id: %v", err)
	}
	if _, err := cmdList(ctx, []string{"--identities", "--project-id", "gone"}); errorKindOf(err) != "unknown-project" {
		t.Errorf("unknown --project-id: %v", err)
	}
	if code, _ := cmdList(ctx, []string{"--primary-ref"}); code != 2 {
		t.Errorf("--primary-ref alone = exit %d, want 2", code)
	}
	if code, _ := cmdList(ctx, []string{"--identities", "--remote"}); code != 2 {
		t.Errorf("--identities --remote = exit %d, want 2", code)
	}
}

// --all keeps project order, skips an unreadable project, and leaves
// primaryRef out where a project has none.
func TestListIdentitiesAllProjects(t *testing.T) {
	root := sandboxDataDir(t)
	withCommits, err := registerProject(seedRepo(t, root, "a"))
	if err != nil {
		t.Fatal(err)
	}
	unborn := filepath.Join(root, "unborn")
	runGitT(t, root, "init", "-q", "-b", "main", unborn)
	empty, err := registerProject(unborn)
	if err != nil {
		t.Fatal(err)
	}
	gone := project{ID: "GONE-" + t.Name(), Name: "gone", Path: filepath.Join(root, "gone")}
	ctx := cliContext{projects: []project{empty, gone, withCommits}}
	entries := listIdentitiesT(t, ctx, "--all", "--primary-ref")
	if len(entries) != 2 || entries[0]["projectId"] != empty.ID || entries[1]["projectId"] != withCommits.ID {
		t.Fatalf("--all = %v, want the unborn project then a, gone skipped", entries)
	}
	if _, has := entries[0]["primaryRef"]; has {
		t.Errorf("a project with no primary ref carries one: %v", entries[0])
	}
	if entries[1]["primaryRef"] != "main" || entries[1]["primaryBranch"] != "main" {
		t.Errorf("local-only primary ref = %v", entries[1])
	}
}

// --- the primary-checkout rule ---

func identitiesT(t *testing.T, proj project) []worktreeIdentity {
	t.Helper()
	invalidateWorktreeIdentities(proj.ID)
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	return identities
}

func primaries(identities []worktreeIdentity) []string {
	var paths []string
	for _, id := range identities {
		if id.IsPrimary {
			paths = append(paths, id.Path)
		}
	}
	return paths
}

// A bare repo's checkouts are all linked worktrees: none is primary,
// so each is removable and root/primary is a clear error.
func TestBareRepoHasNoPrimary(t *testing.T) {
	root := sandboxDataDir(t)
	src := seedRepo(t, root, "src")
	bare := filepath.Join(root, "repo.git")
	runGitT(t, root, "clone", "-q", "--bare", src, bare)
	wtA, wtB := filepath.Join(root, "wt-a"), filepath.Join(root, "wt-b")
	runGitT(t, bare, "worktree", "add", "-q", wtA, "main")
	runGitT(t, bare, "worktree", "add", "-q", "-b", "feat", wtB)
	proj, err := registerProject(bare)
	if err != nil {
		t.Fatal(err)
	}

	identities := identitiesT(t, proj)
	if len(identities) != 2 || identities[0].Path != wtA || identities[1].Path != wtB {
		t.Fatalf("identities = %+v, want wt-a and wt-b", identities)
	}
	if got := primaries(identities); len(got) != 0 {
		t.Fatalf("primaries = %v, want none in a bare repo", got)
	}

	ctx := cliContext{projects: []project{proj}}
	if _, err := resolveWorktree(ctx, "root", "", true); err == nil || !strings.Contains(err.Error(), "no primary checkout") {
		t.Errorf("root in a bare repo: %v, want the no-primary error", err)
	}
	if in := lifecycleEnvInputs(proj, identities[1], nil); in.projectBranch != "" {
		t.Errorf("project branch = %q, want empty without a primary", in.projectBranch)
	}
	// Carry-over has no primary to link into, so a symlink entry is
	// copied from a sibling.
	writeFileT(t, filepath.Join(wtA, ".env"), "x")
	dest := filepath.Join(root, "wt-c")
	runGitT(t, bare, "worktree", "add", "-q", "-b", "c", dest)
	report := applyCarryOver(carryOverSources(proj, dest, ""), dest, []carryOverEntry{{Path: ".env", Mode: "symlink"}})
	if report.Applied != 1 || len(report.Sourced) != 1 || !report.Sourced[0].CopiedInstead {
		t.Errorf("carry-over report = %+v, want one copied-instead entry", report)
	}
	if info, err := os.Lstat(filepath.Join(dest, ".env")); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("carried .env: %v (mode %v), want a copy", err, info)
	}
	// doctor takes the bare repo for what it is.
	report2 := &doctorReport{}
	checkOneProject(report2, proj)
	if f := findingsFor(report2, "project-repo"); len(f) != 0 {
		t.Errorf("doctor flagged the bare repo: %+v", f)
	}
}

// The checkout at the project path is primary wherever git lists it,
// and only it; with none there, the first checkout stands in.
func TestPrimaryIsTheProjectPathWhereverListed(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "repo")
	linked := filepath.Join(root, "linked")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "side", linked)

	// Registered at the linked checkout (listed second): it alone is
	// primary, not also the first entry.
	atLinked := project{ID: "LINKED-" + t.Name(), Name: "linked", Path: linked}
	if got := primaries(identitiesT(t, atLinked)); !slices.Equal(got, []string{linked}) {
		t.Errorf("primaries = %v, want just %s", got, linked)
	}
	// Registered where git lists nothing (a spelling git doesn't use):
	// the first checkout stands in.
	elsewhere := project{ID: "ELSEWHERE-" + t.Name(), Name: "repo", Path: repo + "/"}
	if got := primaries(identitiesT(t, elsewhere)); !slices.Equal(got, []string{repo}) {
		t.Errorf("primaries = %v, want the first checkout %s", got, repo)
	}
	// The ordinary case.
	plain := project{ID: "PLAIN-" + t.Name(), Name: "repo", Path: repo}
	if got := primaries(identitiesT(t, plain)); !slices.Equal(got, []string{repo}) {
		t.Errorf("primaries = %v, want %s", got, repo)
	}
}

// --- projects reorder ---

func TestProjectsReorder(t *testing.T) {
	sandboxDataDir(t)
	seed := `{"projects":[` +
		`{"id":"A","name":"a","path":"/a"},` +
		`{"id":"B","name":"b","path":"/b","futureField":{"x":1}},` +
		`{"id":"C","name":"c","path":"/c"}]}`
	seedRegistry(t, seed)
	reorder := func(ids string) {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdProject(cliContext{}, []string{"reorder", "--ids", ids}); code != 0 || err != nil {
				t.Fatalf("reorder %s: %d, %v", ids, code, err)
			}
		})
		if doc := decodeT[map[string]any](t, onlyDoc(t, docs)); doc["ok"] != true {
			t.Fatalf("reorder answered %v", doc)
		}
	}

	// Already in this order (unknown ids ignored): nothing is written.
	reorder("A, B,terrier-only")
	if got := readFileT(t, registryPath()); got != seed {
		t.Fatalf("a no-op reorder rewrote the registry:\n%s", got)
	}

	reorder("C,stale,A")
	projects, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	ids := joinMapped(projects, func(p project) string { return p.ID })
	if ids != "C, A, B" {
		t.Errorf("order = %s, want C, A, B", ids)
	}
	if raw := readFileT(t, registryPath()); !strings.Contains(raw, `"futureField"`) {
		t.Errorf("an unknown entry field was dropped:\n%s", raw)
	}

	if code, _ := cmdProject(cliContext{}, []string{"reorder"}); code != 2 {
		t.Errorf("reorder without --ids = exit %d, want 2", code)
	}
}

// --- worktrees destination ---

func TestWorktreeDestination(t *testing.T) {
	proj := autoPullSandbox(t)
	createViaCmd(t, proj, "fox")
	base := resolveWorktreeBase(proj.Path, readProjectConfig(proj.ID))
	ctx := cliContext{projects: []project{proj}}
	dest := func(args ...string) map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdDestination(ctx, append([]string{"--project-id", proj.ID}, args...)); code != 0 || err != nil {
				t.Fatalf("destination %v: %d, %v", args, code, err)
			}
		})
		return decodeT[map[string]any](t, onlyDoc(t, docs))
	}

	for _, name := range []string{"fox", "FOX"} {
		if doc := dest("--name", name); doc["taken"] != true || doc["name"] != name || doc["path"] != filepath.Join(base, name) {
			t.Errorf("--name %s = %v, want taken", name, doc)
		}
	}
	doc := dest("--name", "wolf")
	if doc["ok"] != true || doc["taken"] != false || doc["path"] != filepath.Join(base, "wolf") {
		t.Errorf("--name wolf = %v, want free", doc)
	}
	// Something on disk at the path takes it too.
	if err := os.MkdirAll(filepath.Join(base, "wolf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if doc := dest("--name", "wolf"); doc["taken"] != true {
		t.Errorf("occupied path = %v, want taken", doc)
	}

	// No name: a fresh pick from the configured pool, free, never a
	// local branch's name.
	setGlobalBool(t, "doubutsuNames", true)
	runGitT(t, proj.Path, "branch", "kept")
	doc = dest()
	name, _ := doc["name"].(string)
	if !slices.Contains(doubutsuNames(), name) || name == "kept" || doc["taken"] != false ||
		doc["path"] != filepath.Join(base, name) {
		t.Errorf("picked destination = %v", doc)
	}

	if code, _ := cmdDestination(ctx, []string{"--project-id", proj.ID, "--name", "root"}); code != 2 {
		t.Errorf("reserved name = exit %d, want 2", code)
	}
	if code, _ := cmdDestination(ctx, []string{"--project-id", proj.ID, "--name", "a/b"}); code != 2 {
		t.Errorf("invalid name = exit %d, want 2", code)
	}
	if _, err := cmdDestination(ctx, []string{"--project-id", "gone"}); errorKindOf(err) != "unknown-project" {
		t.Errorf("unknown project: %v", err)
	}
}

// --- worktrees rekey ---

func TestRekeyCarriesIDKeyedState(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	if err := setShelved(wt.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := setRegistryMark(autoPullKey, wt.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := setRegistryMark(shelfSnapshotsKey, wt.ID, true); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, worktreeDataPath(proj.ID, wt.ID), `{"notes":"keep me"}`)
	head := strings.TrimSpace(gitOut(t, wt.Path, "rev-parse", "HEAD"))
	runGitT(t, proj.Path, "update-ref", dirtyRef(wt.ID), head)

	// Nothing exists at the destination yet: rekey runs before the move.
	to := filepath.Join(t.TempDir(), "moved", "fox")
	ctx := cliContext{projects: []project{proj}}
	docs := captureJSON(t, func() {
		if code, err := cmdRekey(ctx, []string{"--project-id", proj.ID, "--from-id", wt.ID, "--to-path", to}); code != 0 || err != nil {
			t.Fatalf("rekey: %d, %v", code, err)
		}
	})
	doc := decodeT[map[string]any](t, onlyDoc(t, docs))
	newID := worktreeIDFromPath(to)
	if doc["ok"] != true || doc["id"] != newID {
		t.Fatalf("rekey answered %v, want id %s", doc, newID)
	}
	for _, key := range []string{shelvedKey, autoPullKey} {
		if marks := readRegistryMarkSet(key); marks[wt.ID] || !marks[newID] {
			t.Errorf("%s: old %v new %v, want the mark moved", key, marks[wt.ID], marks[newID])
		}
	}
	// The shelf snapshot is retired, not carried: the next listing
	// takes a fresh one at the new path.
	if snaps := readRegistryMarkSet(shelfSnapshotsKey); snaps[wt.ID] || snaps[newID] {
		t.Errorf("shelfSnapshots: old %v new %v, want neither", snaps[wt.ID], snaps[newID])
	}
	if _, err := os.Stat(worktreeDataPath(proj.ID, wt.ID)); !os.IsNotExist(err) {
		t.Errorf("old data file still there: %v", err)
	}
	if data := readFileT(t, worktreeDataPath(proj.ID, newID)); !strings.Contains(data, "keep me") {
		t.Errorf("data file didn't follow: %q", data)
	}
	if got := strings.TrimSpace(gitOut(t, proj.Path, "rev-parse", dirtyRef(newID))); got != head {
		t.Errorf("dirty capture at new id = %q, want %s", got, head)
	}
	if _, err := runGit(proj.Path, "rev-parse", "--verify", "--quiet", dirtyRef(wt.ID)); err == nil {
		t.Error("dirty capture still under the old id")
	}

	if _, err := cmdRekey(ctx, []string{"--project-id", "gone", "--from-id", "x", "--to-path", to}); errorKindOf(err) != "unknown-project" {
		t.Errorf("unknown project: %v", err)
	}
	for _, args := range [][]string{
		{"--project-id", proj.ID, "--from-id", newID},
		{"--project-id", proj.ID, "--from-id", newID, "--to-path", "relative/fox"},
	} {
		if code, _ := cmdRekey(ctx, args); code != 2 {
			t.Errorf("rekey %v = exit %d, want 2", args, code)
		}
	}
}

// --- sm open by exact address, launchers --catalog ---

func TestOpenByExactAddress(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	// A custom launcher labeled like the Finder's full id must not
	// shadow it.
	writeFileT(t, configJSONPath(), `{"launchers":[`+
		`{"id":"a1","label":"Write marker","command":"echo opened > \"$SHIGOMORI_WORKSPACE_PATH/opened.txt\""},`+
		`{"id":"b2","label":"app:finder","command":"true"}]}`)
	ctx := cliContext{projects: []project{proj}}

	var launched []string
	launchEntryFn = func(entry launcherEntry, path string) error {
		launched = append(launched, entry.id+" "+path)
		return nil
	}
	t.Cleanup(func() { launchEntryFn = launchEntry })
	open := func(args ...string) map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdOpen(ctx, args); code != 0 || err != nil {
				t.Fatalf("open %v: %d, %v", args, code, err)
			}
		})
		return decodeT[map[string]any](t, onlyDoc(t, docs))
	}

	doc := open("--project-id", proj.ID, "--worktree-id", fox.ID, "--", "custom:a1")
	if doc["ok"] != true || doc["launcher"] != "custom:a1" || doc["worktree"] != "fox" {
		t.Errorf("open answered %v", doc)
	}
	primaryID := worktreeIDFromPath(proj.Path)
	open("--project-id", proj.ID, "--worktree-id", primaryID, "--", "app:finder")
	want := []string{"custom:a1 " + fox.Path, "app:finder " + proj.Path}
	if !slices.Equal(launched, want) {
		t.Errorf("launched %v, want %v", launched, want)
	}
	if useLog := readStateHintKey[map[string][]int64]("launcherUseLog"); len(useLog["custom:a1"]) != 1 || len(useLog["app:finder"]) != 1 {
		t.Errorf("use log = %v, want one use each", useLog)
	}

	if _, err := cmdOpen(ctx, []string{"--project-id", proj.ID, "--worktree-id", fox.ID, "--", "custom:nope"}); errorKindOf(err) != "unknown-launcher" {
		t.Errorf("unknown launcher: %v", err)
	}
	if _, err := cmdOpen(ctx, []string{"--project-id", proj.ID, "--worktree-id", "gone", "--", "app:finder"}); errorKindOf(err) != "unknown-worktree" {
		t.Errorf("unknown worktree: %v", err)
	}
	if code, _ := cmdOpen(ctx, []string{"--project-id", proj.ID, "app:finder"}); code != 2 {
		t.Errorf("--project-id without --worktree-id = exit %d, want 2", code)
	}

	// A launch that fails is the {ok: false, error} document.
	launchEntryFn = func(launcherEntry, string) error { return errors.New("boom") }
	docs := captureJSON(t, func() {
		code, err := cmdOpen(ctx, []string{"--project-id", proj.ID, "--worktree-id", fox.ID, "--", "custom:a1"})
		if code != 1 || err == nil {
			t.Fatalf("failed launch = %d, %v", code, err)
		}
		reportError(err)
	})
	failed := decodeT[map[string]any](t, onlyDoc(t, docs))
	if failed["ok"] != false || !strings.Contains(failed["error"].(string), "boom") {
		t.Errorf("failed launch document = %v", failed)
	}

	// The real launcher, through the entrypoint the app spawns, with the
	// tool after --.
	launchEntryFn = launchEntry
	savedArgs := os.Args
	t.Cleanup(func() { os.Args = savedArgs })
	os.Args = []string{binaryName, "--json", "open", "--project-id", proj.ID, "--worktree-id", fox.ID, "--", "custom:a1"}
	docs = captureJSON(t, func() {
		if code := run(); code != 0 {
			t.Fatalf("run = %d", code)
		}
	})
	if doc := decodeT[map[string]any](t, onlyDoc(t, docs)); doc["launcher"] != "custom:a1" {
		t.Errorf("entrypoint open answered %v", doc)
	}
	marker := filepath.Join(fox.Path, "opened.txt")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if data, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(data)) == "opened" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the custom launcher never wrote its marker")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLauncherCatalog(t *testing.T) {
	sandboxDataDir(t)
	// No projects and no project flags: the catalog needs none.
	docs := captureJSON(t, func() {
		if code, err := cmdLaunchers(cliContext{}, []string{"--catalog"}); code != 0 || err != nil {
			t.Fatalf("launchers --catalog: %d, %v", code, err)
		}
	})
	doc := decodeT[struct {
		OK   bool             `json:"ok"`
		Apps []map[string]any `json:"apps"`
	}](t, onlyDoc(t, docs))
	if !doc.OK || len(doc.Apps) != len(launcherCatalog) {
		t.Fatalf("catalog = %+v, want every one of %d entries", doc, len(launcherCatalog))
	}
	var labels []string
	for _, app := range doc.Apps {
		id, _ := app["id"].(string)
		if app["kind"] != "detected" || !strings.HasPrefix(id, "app:") {
			t.Errorf("entry = %v", app)
		}
		if _, ok := app["available"].(bool); !ok {
			t.Errorf("entry without an available flag: %v", app)
		}
		if id == "app:finder" && app["available"] != true {
			t.Errorf("finder unavailable: %v", app)
		}
		labels = append(labels, strings.ToLower(app["label"].(string)))
	}
	if !slices.IsSorted(labels) {
		t.Errorf("catalog not sorted by label: %v", labels)
	}
}

// --- sm run ---

func TestRunDropsTransitionalFlagsAndListWritesNothing(t *testing.T) {
	proj := autoPullSandbox(t)
	ctx := cliContext{projects: []project{proj}}
	primaryID := worktreeIDFromPath(proj.Path)
	for _, flag := range []string{"--skip-use-log", "--project-branch=main", "--default-branch=main"} {
		if code, _ := cmdRun(ctx, []string{"--worktree-id", primaryID, flag}); code != 2 {
			t.Errorf("%s = exit %d, want 2 (removed)", flag, code)
		}
	}
	// No package.json: the coded failure, and no use-log write.
	seedState(t, `{"keep":true}`)
	before := readFileT(t, statePath())
	captureJSON(t, func() {
		if _, err := cmdRun(ctx, []string{"--project-id", proj.ID, "--worktree-id", primaryID}); errorKindOf(err) != "no-package-json" {
			t.Errorf("no package.json: %v (kind %q)", err, errorKindOf(err))
		}
	})
	if after := readFileT(t, statePath()); after != before {
		t.Errorf("the list form wrote state.json:\n%s", after)
	}
}
