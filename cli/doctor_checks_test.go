package main

// Tests for the doctor check logic: every case runs against a
// hand-seeded temp data dir (and, where a repo is needed, a temp
// git repo), so the real ~/.sm is never read and never written.
// The environment checks (git, gh, the app bundle, PATH) are left to
// their pure helpers, since shelling out to the host's tools would
// make the suite describe the machine instead of the code.

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A repo with one empty commit on main, at <parent>/<name>.
func seedRepo(t *testing.T, parent, name string) string {
	t.Helper()
	path := filepath.Join(parent, name)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	deterministicGitEnv(t)
	runGitT(t, path, "init", "-q", "-b", "main")
	runGitT(t, path, "commit", "-q", "--allow-empty", "-m", "init")
	return path
}

func commitEmpty(t *testing.T, dir, msg string) {
	t.Helper()
	mustGit(t, dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg)
}

// Runs git in dir, failing the test with the command that broke.
func mustGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := runGit(dir, args...); err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
}

// The findings for one check id, in record order.
func findingsFor(report *doctorReport, id string) []finding {
	var matched []finding
	for _, f := range report.findings {
		if f.ID == id {
			matched = append(matched, f)
		}
	}
	return matched
}

// Asserts exactly one finding with the given id and status, and
// returns it.
func onlyFinding(t *testing.T, report *doctorReport, id, status string) finding {
	t.Helper()
	matched := findingsFor(report, id)
	if len(matched) != 1 {
		t.Fatalf("%s: %d findings, want 1 (%+v)", id, len(matched), report.findings)
	}
	if matched[0].Status != status {
		t.Fatalf("%s: status %q, want %q (%s)", id, matched[0].Status, status, matched[0].Detail)
	}
	return matched[0]
}

// --- data dir ---

func TestCheckGlobalConfig(t *testing.T) {
	cases := []struct {
		name    string
		content string
		write   bool
		status  string
	}{
		{"absent", "", false, statusOK},
		{"valid", `{"portPool": true}`, true, statusOK},
		{"truncated", `{"portPool": true, `, true, statusFail},
		{"not an object", `[1, 2]`, true, statusFail},
		{"wrong field type", `{"portPool": "yes"}`, true, statusWarn},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sandboxDataDir(t)
			if tc.write {
				writeFileT(t, configJSONPath(), tc.content)
			}
			report := &doctorReport{}
			checkGlobalConfig(report)
			onlyFinding(t, report, "config", tc.status)
		})
	}
}

func TestCheckRegistryFile(t *testing.T) {
	cases := []struct {
		name    string
		content string
		write   bool
		status  string
	}{
		{"absent", "", false, statusOK},
		{"valid", `{"projects": [{"id":"A","name":"a","path":"/tmp/a"}]}`, true, statusOK},
		{"no projects key", `{"shelvedWorktrees": {}}`, true, statusOK},
		{"invalid json", `{"projects": [`, true, statusFail},
		{"projects wrong shape", `{"projects": {"a": 1}}`, true, statusFail},
		{"entry missing path", `{"projects": [{"id":"A","name":"a"}]}`, true, statusWarn},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sandboxDataDir(t)
			if tc.write {
				writeFileT(t, registryPath(), tc.content)
			}
			report := &doctorReport{}
			checkRegistryFile(report)
			onlyFinding(t, report, "registry", tc.status)
		})
	}
}

// A malformed registry.json is the one failure that makes sm forget every
// project silently, so it must never read as a warning.
func TestMalformedRegistryIsFatalNotAWarning(t *testing.T) {
	sandboxDataDir(t)
	writeFileT(t, registryPath(), "definitely not json")
	report := &doctorReport{}
	checkRegistryFile(report)
	finding := onlyFinding(t, report, "registry", statusFail)
	if finding.Fix == "" {
		t.Fatal("a fatal finding must carry a suggested fix")
	}
}

func TestFindStaleLocksIgnoresFreshOnes(t *testing.T) {
	root := sandboxDataDir(t)
	fresh := filepath.Join(root, "state.json.lock")
	writeFileT(t, fresh, "1234")
	stale := projectConfigJSONPath("AAA") + ".lock"
	writeFileT(t, stale, "1234")
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	// A non-lock file next door must never be swept up.
	writeFileT(t, projectConfigJSONPath("AAA"), "{}")

	found := findStaleLocks(root)
	if len(found) != 1 || found[0] != stale {
		t.Fatalf("found %v, want just %s", found, stale)
	}
}

func TestStaleLockRepairDeletesEveryLock(t *testing.T) {
	root := sandboxDataDir(t)
	old := time.Now().Add(-time.Hour)
	var locks []string
	for _, rel := range []string{"state.json.lock", "projects/AAA/project.json.lock"} {
		path := filepath.Join(root, filepath.FromSlash(rel))
		writeFileT(t, path, "1")
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
		locks = append(locks, path)
	}
	report := &doctorReport{}
	checkStaleLocks(report)
	finding := onlyFinding(t, report, "locks", statusWarn)
	if finding.repair == nil || !finding.repair.destructive {
		t.Fatal("deleting lock files must be offered as a destructive repair")
	}
	if err := finding.repair.apply(); err != nil {
		t.Fatalf("apply: %v", err)
	}
	for _, lock := range locks {
		if _, err := os.Stat(lock); !os.IsNotExist(err) {
			t.Fatalf("%s survived the repair", lock)
		}
	}
	// And the check is quiet afterwards.
	after := &doctorReport{}
	checkStaleLocks(after)
	onlyFinding(t, after, "locks", statusOK)
}

func TestCheckStagingLock(t *testing.T) {
	sandboxDataDir(t)
	// Absent: no line at all, the normal case.
	report := &doctorReport{}
	checkStagingLock(report)
	if len(report.findings) != 0 {
		t.Fatalf("absent staging lock produced %+v", report.findings)
	}

	// A live pid (our own) is an update in progress, not a leftover.
	path := stagingLockPath()
	writeFileT(t, path, strconv.Itoa(os.Getpid())+"\n")
	report = &doctorReport{}
	checkStagingLock(report)
	onlyFinding(t, report, "staging-lock", statusOK)

	// A dead pid is a crashed stager, and repairable.
	writeFileT(t, path, "999999")
	report = &doctorReport{}
	checkStagingLock(report)
	finding := onlyFinding(t, report, "staging-lock", statusWarn)
	if finding.repair == nil {
		t.Fatal("a dead staging lock must be repairable")
	}
	if err := finding.repair.apply(); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("staging.pid survived the repair")
	}
}

// --- projects ---

func TestProjectPathGoneIsFatalAndRepairable(t *testing.T) {
	root := sandboxDataDir(t)
	proj := project{ID: "GONE1", Name: "ghost", Path: filepath.Join(root, "repos", "ghost")}
	writeFileT(t, projectConfigJSONPath(proj.ID), `{"defaultBranch":"main"}`)
	writeFileT(t, registryPath(),
		`{"projects":[{"id":"GONE1","name":"ghost","path":"`+proj.Path+`"}]}`)

	report := &doctorReport{}
	checkOneProject(report, proj)
	finding := onlyFinding(t, report, "project-path", statusFail)
	if finding.repair == nil || !finding.repair.destructive {
		t.Fatal("unregistering must be offered, and must be destructive")
	}
	if err := finding.repair.apply(); err != nil {
		t.Fatalf("apply: %v", err)
	}
	remaining, err := loadProjects()
	if err != nil {
		t.Fatalf("loadProjects: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("registry still holds %+v", remaining)
	}
	if _, err := os.Stat(projectDataDir(proj.ID)); !os.IsNotExist(err) {
		t.Fatal("the project's state dir survived the repair")
	}
}

func TestProjectPathThatStoppedBeingARepo(t *testing.T) {
	root := sandboxDataDir(t)
	path := filepath.Join(root, "repos", "plain")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	report := &doctorReport{}
	checkOneProject(report, project{ID: "P1", Name: "plain", Path: path})
	finding := onlyFinding(t, report, "project-repo", statusFail)
	// Ambiguous by nature (re-init? unregister? restore a backup?), so
	// it must never carry a repair.
	if finding.repair != nil {
		t.Fatal("a directory that stopped being a repo must not be auto-fixed")
	}
}

func TestHealthyProjectRecordsNothing(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	writeFileT(t, projectConfigJSONPath(proj.ID),
		`{"defaultBranch":"main","scripts":{"setup":"pnpm install"}}`)
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkOneProject(report, proj)
	if len(report.findings) != 0 {
		t.Fatalf("healthy project produced findings: %+v", report.findings)
	}
}

func TestWorktreeMetadataOutlivingItsDirectory(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	writeFileT(t, projectConfigJSONPath(proj.ID), `{"defaultBranch":"main"}`)

	worktree := filepath.Join(root, "worktrees", "alpha", "vanished")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "vanished", worktree)
	invalidateAllWorktreeIdentities()
	id := worktreeByName(t, proj, "vanished")
	if err := setShelved(id.ID, true); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, worktreeDataPath(proj.ID, id.ID), `{"notes":"x"}`)
	if err := os.RemoveAll(worktree); err != nil {
		t.Fatal(err)
	}
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkProjectWorktrees(report, proj, nil)
	finding := onlyFinding(t, report, "project-worktrees", statusWarn)
	if finding.repair == nil {
		t.Fatal("prunable metadata must be repairable")
	}
	// A checkout moved somewhere doctor doesn't look is severed by a
	// prune, so it asks first.
	if !finding.repair.destructive {
		t.Fatal("git worktree prune must be treated as destructive")
	}
	if err := finding.repair.apply(); err != nil {
		t.Fatalf("apply: %v", err)
	}
	invalidateAllWorktreeIdentities()
	after := &doctorReport{}
	checkProjectWorktrees(after, proj, nil)
	if len(findingsFor(after, "project-worktrees")) != 0 {
		t.Fatalf("still reported after the prune: %+v", after.findings)
	}
	// The prune clears what `sm rm` would have.
	if readShelvedSet()[id.ID] {
		t.Fatal("the pruned worktree's shelved mark survived")
	}
	if _, err := os.Stat(worktreeDataPath(proj.ID, id.ID)); !os.IsNotExist(err) {
		t.Fatal("the pruned worktree's data file survived")
	}
}

// A worktree moved by hand (or by a data-folder move whose repair
// failed) reads as missing at its old path and a stray at its new one.
// Pruning would cut it off from the repo, so doctor re-links it, and
// its marks follow it to the new id.
func TestMovedWorktreeIsRelinkedNotPruned(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	outside := filepath.Join(root, "elsewhere", "feat")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "feat", outside)
	invalidateAllWorktreeIdentities()
	old := worktreeByName(t, proj, "feat")
	if err := setShelved(old.ID, true); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(root, "worktrees", "alpha", "feat")
	if err := os.MkdirAll(filepath.Dir(moved), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(outside, moved); err != nil {
		t.Fatal(err)
	}
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkProjectWorktrees(report, proj, nil)
	if n := len(findingsFor(report, "project-worktrees")) + len(findingsFor(report, "project-strays")); n != 0 {
		t.Fatalf("a moved worktree read as missing or stray: %+v", report.findings)
	}
	finding := onlyFinding(t, report, "project-moved", statusWarn)
	if finding.repair == nil || finding.repair.destructive {
		t.Fatal("re-linking must be offered without a prompt: it only rewrites git's link files")
	}
	if err := finding.repair.apply(); err != nil {
		t.Fatalf("apply: %v", err)
	}
	invalidateAllWorktreeIdentities()
	if _, err := runGit(moved, "status"); err != nil {
		t.Fatalf("the moved checkout isn't a working worktree after the repair: %v", err)
	}
	after := &doctorReport{}
	checkProjectWorktrees(after, proj, nil)
	if len(after.findings) != 0 {
		t.Fatalf("still reported after the re-link: %+v", after.findings)
	}
	now := worktreeByName(t, proj, "feat")
	shelved := readShelvedSet()
	if shelved[old.ID] || !shelved[now.ID] {
		t.Fatalf("the shelved mark didn't follow the move (old %v, new %v)", shelved[old.ID], shelved[now.ID])
	}
}

// The prune re-checks when it runs: while a moved worktree still waits
// to be re-linked (its re-link failed, or was declined), pruning would
// sever it, so it stands down.
func TestPruneStandsDownWhileAMovedWorktreeIsUnlinked(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	outside := filepath.Join(root, "elsewhere", "feat")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "feat", outside)
	gone := filepath.Join(root, "worktrees", "alpha", "gone")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "gone", gone)
	moved := filepath.Join(root, "worktrees", "alpha", "feat")
	if err := os.Rename(outside, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkProjectWorktrees(report, proj, nil)
	onlyFinding(t, report, "project-moved", statusWarn)
	prune := onlyFinding(t, report, "project-worktrees", statusWarn)
	if prune.repair.apply() == nil {
		t.Fatal("the prune ran with a moved worktree still unlinked")
	}
	if _, err := runGit(moved, "status"); err != nil {
		t.Fatalf("the moved worktree was severed: %v", err)
	}
}

// A locked worktree is one git keeps on purpose while it's away.
func TestLockedMissingWorktreeIsLeftAlone(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	worktree := filepath.Join(root, "worktrees", "alpha", "external")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "external", worktree)
	runGitT(t, repo, "worktree", "lock", worktree)
	if err := os.RemoveAll(worktree); err != nil {
		t.Fatal(err)
	}
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkProjectWorktrees(report, proj, nil)
	if len(report.findings) != 0 {
		t.Fatalf("a locked worktree was reported: %+v", report.findings)
	}
}

func worktreeByName(t *testing.T, proj project, name string) worktreeIdentity {
	t.Helper()
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range identities {
		if id.Name == name {
			return id
		}
	}
	t.Fatalf("no worktree named %s in %+v", name, identities)
	return worktreeIdentity{}
}

func TestStrayDirectoryInManagedLayoutIsReportedNotFixed(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	stray := filepath.Join(root, "worktrees", "alpha", "stray")
	if err := os.MkdirAll(stray, 0o755); err != nil {
		t.Fatal(err)
	}
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkProjectWorktrees(report, proj, nil)
	finding := onlyFinding(t, report, "project-strays", statusWarn)
	if finding.repair != nil {
		t.Fatal("a stray directory could be anything; it must never be auto-removed")
	}
	if !strings.Contains(finding.Detail, "stray") {
		t.Fatalf("detail doesn't name the directory: %s", finding.Detail)
	}
}

// project.json that fails the schema's required-field check is treated
// as absent by both the app and the CLI, silently, which is exactly
// what makes it worth a line.
func TestProjectConfigPresentButInvalid(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "beta")
	proj := project{ID: "B1", Name: "beta", Path: repo}
	writeFileT(t, projectConfigJSONPath(proj.ID),
		`{"scripts":{"setup":"pnpm install"}}`)
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkOneProject(report, proj)
	onlyFinding(t, report, "project-config", statusWarn)
}

func TestCheckProjectDefaultBranch(t *testing.T) {
	root := sandboxDataDir(t)
	// A bad override still falls back to a real branch, so there is
	// nothing to say.
	repo := seedRepo(t, root, "gamma")
	report := &doctorReport{}
	checkProjectDefaultBranch(report, project{ID: "G1", Name: "gamma", Path: repo},
		&projectConfig{DefaultBranch: "release/never-existed"})
	if len(report.findings) != 0 {
		t.Fatalf("a resolvable fallback should stay quiet: %+v", report.findings)
	}

	// An unborn HEAD has no branch at all: create would have no base.
	empty := filepath.Join(root, "empty")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitT(t, empty, "init", "-q", "-b", "main")
	report = &doctorReport{}
	checkProjectDefaultBranch(report, project{ID: "E1", Name: "empty", Path: empty}, nil)
	onlyFinding(t, report, "project-branch", statusWarn)
}

func TestMissingScriptFiles(t *testing.T) {
	dir := t.TempDir()
	writeFileT(t, filepath.Join(dir, "scripts", "present.sh"), "#!/bin/sh\n")
	cases := []struct {
		command string
		want    []string
	}{
		{"pnpm install", nil},
		{"bash scripts/present.sh", nil},
		{"bash ./scripts/present.sh", nil},
		{"bash scripts/absent.sh", []string{"scripts/absent.sh"}},
		{"bash ./scripts/absent.sh --ci", []string{"./scripts/absent.sh"}},
		// Anything with shell syntax, a variable, a URL, or no slash is
		// out of scope: a false alarm is worse than a missed one.
		{"bash $SETUP/absent.sh", nil},
		{"curl https://example.com/x.sh | sh", nil},
		{"make setup", nil},
		{"bash /opt/absent.sh", nil},
		{"npx some-tool --config a/b/c.json", []string{"a/b/c.json"}},
	}
	for _, tc := range cases {
		t.Run(tc.command, func(t *testing.T) {
			got := missingScriptFiles(dir, tc.command)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestUnreadableWorktreeIncludeIsReported(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "delta")
	proj := project{ID: "D1", Name: "delta", Path: repo}
	include := filepath.Join(repo, worktreeIncludeFile)
	writeFileT(t, include, ".env\n")
	if err := os.Chmod(include, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(include, 0o644) })

	report := &doctorReport{}
	checkProjectWorktreeInclude(report, proj, nil)
	onlyFinding(t, report, "project-include", statusWarn)
}

// --- worktree bookkeeping ---

func TestOrphanedWorktreeMarks(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	invalidateAllWorktreeIdentities()
	projects := []project{proj}
	primary := worktreeIDFromPath(repo)

	// Marks and data on the primary checkout's own id are legitimate.
	writeFileT(t, registryPath(),
		`{"shelvedWorktrees":{"`+primary+`":true},"autoPullWorktrees":{"`+primary+`":true}}`)
	writeFileT(t, worktreeDataPath(proj.ID, primary), `{}`)
	report := &doctorReport{}
	checkWorktreeBookkeeping(report, projects, true)
	onlyFinding(t, report, "bookkeeping", statusOK)

	// Every id-keyed map counts, and so does a data file, not only the
	// shelf.
	writeFileT(t, registryPath(),
		`{"autoPullWorktrees":{"0123456789ab":true},"shelfSnapshots":{"ba9876543210":{}}}`)
	writeFileT(t, worktreeDataPath(proj.ID, "cafecafecafe"), `{}`)
	report = &doctorReport{}
	checkWorktreeBookkeeping(report, projects, true)
	finding := onlyFinding(t, report, "bookkeeping", statusWarn)
	if !strings.Contains(finding.Detail, "2 marks and 1 data file") {
		t.Fatalf("detail miscounts: %s", finding.Detail)
	}
	if finding.repair != nil {
		t.Fatal("orphaned marks are harmless; they must not be auto-removed")
	}
}

func TestCheckStateFile(t *testing.T) {
	sandboxDataDir(t)
	report := &doctorReport{}
	checkStateFile(report)
	if len(report.findings) != 0 {
		t.Fatalf("an absent state.json needs no line: %+v", report.findings)
	}
	writeFileT(t, statePath(), `{"launcherUseLog":{}}`)
	report = &doctorReport{}
	checkStateFile(report)
	onlyFinding(t, report, "state", statusOK)

	writeFileT(t, statePath(), `{nope`)
	report = &doctorReport{}
	checkStateFile(report)
	onlyFinding(t, report, "state", statusWarn)
}

// --- dormant project state ---

func TestDormantProjectStateIsReportedNotFixed(t *testing.T) {
	sandboxDataDir(t)
	writeFileT(t, registryPath(), `{"projects":[{"id":"A1","name":"alpha","path":"/tmp/alpha"}]}`)
	writeFileT(t, projectConfigJSONPath("A1"), `{"defaultBranch":"main"}`)
	// Terrier-sourced projects claim their dirs by the deterministic id.
	terrierID := terrierProjectID("/tmp/beta")
	writeFileT(t, projectConfigJSONPath(terrierID), `{"defaultBranch":"main"}`)
	projects := []project{
		{ID: "A1", Name: "alpha", Path: "/tmp/alpha"},
		{ID: terrierID, Name: "beta", Path: "/tmp/beta", Source: "terrier"},
	}

	report := &doctorReport{}
	checkDormantProjectState(report, projects, true)
	onlyFinding(t, report, "dormant-state", statusOK)

	// Left behind by a terrier rm of a repo sm held config for.
	gone := terrierProjectID("/tmp/gone")
	writeFileT(t, projectConfigJSONPath(gone), `{"defaultBranch":"main"}`)
	report = &doctorReport{}
	checkDormantProjectState(report, projects, true)
	finding := onlyFinding(t, report, "dormant-state", statusWarn)
	if !strings.Contains(finding.Detail, gone) {
		t.Fatalf("the detail should name the dormant dir: %s", finding.Detail)
	}
	if finding.repair != nil {
		t.Fatal("dormant state can reconnect on re-registration, so it must not be auto-removed")
	}
}

// With the registry or terrier unreadable the project list is short,
// so every state dir it leaves out would look dormant. Their own
// findings say enough.
func TestDormantProjectStateSkippedWhenTheListIsShort(t *testing.T) {
	sandboxDataDir(t)
	writeFileT(t, projectConfigJSONPath("A1"), `{"defaultBranch":"main"}`)

	report := &doctorReport{}
	checkDormantProjectState(report, nil, false)
	if got := findingsFor(report, "dormant-state"); len(got) != 0 {
		t.Fatalf("no finding expected over a broken registry, got %+v", got)
	}
}

// --- pure helpers ---

func TestParsePortPoolDirs(t *testing.T) {
	stdout := `Current allocations:
  3038 -> /Users/x/worktrees/alpha (8/15/2026, 5:45:00 PM)
    renderer=3038
  4072 -> /Users/x/web/songloupe (8/15/2026, 6:46:41 PM)
`
	got := parsePortPoolDirs(stdout)
	want := []string{"/Users/x/worktrees/alpha", "/Users/x/web/songloupe"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	// Unrecognized output degrades to "nothing found", never to a wrong
	// diagnosis.
	if dirs := parsePortPoolDirs("something else entirely\n"); len(dirs) != 0 {
		t.Fatalf("unrecognized output parsed as %v", dirs)
	}
}

func TestParseGitVersion(t *testing.T) {
	cases := []struct {
		raw          string
		major, minor int
		ok           bool
	}{
		{"2.39.5", 2, 39, true},
		{"2.54.0 (Apple Git-157)", 2, 54, true},
		{"2.51.0.1", 2, 51, true},
		{"2.30", 2, 30, true},
		{"3", 3, 0, true},
		{"", 0, 0, false},
		{"unknown", 0, 0, false},
	}
	for _, tc := range cases {
		major, minor, ok := parseGitVersion(tc.raw)
		if ok != tc.ok || major != tc.major || minor != tc.minor {
			t.Fatalf("%q -> %d.%d/%v, want %d.%d/%v",
				tc.raw, major, minor, ok, tc.major, tc.minor, tc.ok)
		}
	}
	if !belowGitFloor(2, 30) {
		t.Fatal("2.30 must sort below the minimum")
	}
	if belowGitFloor(2, 31) {
		t.Fatal("the minimum must not sort below itself")
	}
	if belowGitFloor(3, 0) {
		t.Fatal("3.0 must sort above the minimum")
	}
}

func TestSameDirectoryFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if !sameDirectory(link, real) {
		t.Fatal("a symlink and its target are the same directory")
	}
	other := filepath.Join(dir, "other")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	if sameDirectory(real, other) {
		t.Fatal("distinct directories must not compare equal")
	}
	// "Can't tell" must never read as "same".
	if sameDirectory(real, filepath.Join(dir, "nope")) {
		t.Fatal("an unresolvable path must not compare equal")
	}
}

// The hook the current build writes is, by definition, current; an
// older vintage in the same fence is not.
func TestHookBlockCurrent(t *testing.T) {
	sandboxHome(t)
	if err := installHook("zsh"); err != nil {
		t.Fatalf("install: %v", err)
	}
	if !hookBlockCurrent("zsh", inspectHook("zsh")) {
		t.Fatal("a freshly installed hook must read as current")
	}
	rc := hookPath("zsh")
	vintage := hookBeginMarker() + "\n" +
		`eval "$(` + binaryName + ` shell init zsh)"` + "\n" + hookEndMarker() + "\n"
	if err := os.WriteFile(rc, []byte(vintage), 0o644); err != nil {
		t.Fatal(err)
	}
	if hookStateOf("zsh").State != "installed" {
		t.Fatal("an older guard line is still recognizably ours")
	}
	if hookBlockCurrent("zsh", inspectHook("zsh")) {
		t.Fatal("an older vintage must read as stale")
	}
}

// --- report plumbing ---

func TestReportCountsAndRepairableCount(t *testing.T) {
	report := &doctorReport{}
	report.ok(groupState, "a", "a", "fine")
	report.warn(groupState, "b", "b", "hmm", "do x")
	report.fail(groupState, "c", "c", "broken", "do y")
	report.add(finding{Group: groupState, ID: "d", Status: statusWarn,
		repair: &repair{label: "fixed d", apply: func() error { return nil }}})

	ok, warn, fail := report.counts()
	if ok != 1 || warn != 2 || fail != 1 {
		t.Fatalf("counts %d/%d/%d, want 1/2/1", ok, warn, fail)
	}
	if got := repairableCount(report); got != 1 {
		t.Fatalf("repairable %d, want 1", got)
	}
}

// A destructive repair must not run just because stdio isn't a
// terminal: silence is not consent.
func TestApplyRepairsSkipsDestructiveWithoutConsent(t *testing.T) {
	ran := false
	report := &doctorReport{}
	report.add(finding{Group: groupState, ID: "x", Status: statusWarn,
		repair: &repair{
			label: "deleted x", destructive: true,
			apply: func() error { ran = true; return nil },
		}})
	if applied, _ := applyRepairs(report, false); len(applied) != 0 || ran {
		t.Fatal("a destructive repair ran without --yes and without a terminal")
	}
	if applied, _ := applyRepairs(report, true); len(applied) != 1 || !ran {
		t.Fatalf("--yes did not apply the repair (applied %v)", applied)
	}
}

func TestApplyRepairsReportsFailuresAndKeepsGoing(t *testing.T) {
	second := false
	report := &doctorReport{}
	report.add(finding{Group: groupState, ID: "x", Status: statusWarn,
		repair: &repair{label: "first", apply: func() error { return os.ErrPermission }}})
	report.add(finding{Group: groupState, ID: "y", Status: statusWarn,
		repair: &repair{label: "second", apply: func() error { second = true; return nil }}})

	applied, failed := applyRepairs(report, true)
	if !second {
		t.Fatal("a failing repair stopped the ones after it")
	}
	if len(applied) != 1 || applied[0] != "second" {
		t.Fatalf("applied %v, want just the one that worked", applied)
	}
	if len(failed) != 1 || !strings.HasPrefix(failed[0], "couldn't first: ") {
		t.Fatalf("failed %v, want the first repair's error", failed)
	}
}

// --- what --fix is allowed to touch ---

// iconCache/ takes index.json.lock under the same advisory protocol as
// the rest of the data dir, so a crashed icon write leaves exactly the kind
// of lock this check exists to find. updates/ holds staged downloads
// and never a lock, so a file that merely ends in .lock there is not
// ours to delete.
func TestFindStaleLocksScansIconCacheButNotUpdates(t *testing.T) {
	root := sandboxDataDir(t)
	old := time.Now().Add(-time.Hour)
	stale := func(path string) string {
		writeFileT(t, path, "1")
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
		return path
	}
	iconLock := stale(filepath.Join(root, "iconCache", "index.json.lock"))
	updatesLock := stale(filepath.Join(root, "updates", "something.lock"))

	found := findStaleLocks(root)
	if len(found) != 1 || found[0] != iconLock {
		t.Fatalf("found %v, want just %s", found, iconLock)
	}
	if _, err := os.Stat(updatesLock); err != nil {
		t.Fatalf("the updates/ file should have been left alone: %v", err)
	}
}

// The file header's promise: a plain `doctor` run reports, and changes
// nothing. The one sanctioned exception is the state.json -> registry.json
// migration, which is why this data dir is seeded already split.
func TestDoctorWithoutFixWritesNothing(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	writeFileT(t, registryPath(),
		`{"projects":[{"id":"A1","name":"alpha","path":"`+repo+`"}],"shelvedWorktrees":{"deadbeef1234":true}}`)
	writeFileT(t, configJSONPath(), `{"portPool":false}`)
	writeFileT(t, projectConfigJSONPath(proj.ID), `{"defaultBranch":"main"}`)
	// Faults for the checks to have something to say about.
	writeFileT(t, filepath.Join(root, "state.json.lock"), "1")
	writeFileT(t, stagingLockPath(), "999999")
	invalidateAllWorktreeIdentities()

	before := snapshotTree(t, root)
	report := runDoctorChecks([]project{proj}, true)
	if len(report.findings) == 0 {
		t.Fatal("nothing was checked, so the assertion below proves nothing")
	}
	if _, _, failed := report.counts(); failed != 0 {
		t.Fatalf("this fixture should only warn, got %d failures: %+v", failed, report.findings)
	}
	if after := snapshotTree(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("doctor wrote to the data dir:\nbefore %v\nafter  %v", before, after)
	}
}

// path -> "<size>:<content hash>" for every file under dir, so a
// rewrite with identical length is still caught.
func snapshotTree(t *testing.T, dir string) map[string]string {
	t.Helper()
	seen := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		seen[path] = fmt.Sprintf("%d:%x", len(data), sha256.Sum256(data))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return seen
}

// The two callers of removeProjectRegistration disagree about a missing
// entry on purpose: `projects remove` is answering a name the user
// typed, doctor's repair is racing the app.
func TestRemoveProjectRegistrationMissingEntry(t *testing.T) {
	sandboxDataDir(t)
	writeFileT(t, registryPath(), `{"projects":[{"id":"KEEP","name":"keep","path":"/tmp/keep"}]}`)

	if err := removeProjectRegistration("ABSENT", false); err == nil {
		t.Fatal("`projects remove` must reject an id that isn't registered")
	}
	if err := removeProjectRegistration("ABSENT", true); err != nil {
		t.Fatalf("doctor's repair must tolerate an entry that's already gone: %v", err)
	}
	remaining, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].ID != "KEEP" {
		t.Fatalf("the surviving entry was disturbed: %+v", remaining)
	}
}

// Unregistering drops sm's own state for a project. The repo it points
// at belongs to the user and must survive, whatever else happens.
func TestUnregisteringNeverTouchesTheRepo(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	writeFileT(t, filepath.Join(repo, "keep-me.txt"), "user data")
	writeFileT(t, registryPath(),
		`{"projects":[{"id":"A1","name":"alpha","path":"`+repo+`"}]}`)
	writeFileT(t, projectConfigJSONPath("A1"), `{"defaultBranch":"main"}`)

	if err := removeProjectRegistration("A1", false); err != nil {
		t.Fatal(err)
	}
	if err := removeProjectState("A1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projectDataDir("A1")); !os.IsNotExist(err) {
		t.Fatal("the project's state dir should be gone")
	}
	if _, err := os.Stat(filepath.Join(repo, "keep-me.txt")); err != nil {
		t.Fatalf("the repo must be left alone: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, ".git")); err != nil {
		t.Fatalf("the repo must still be a repo: %v", err)
	}
}

// A healthy data dir offers nothing to repair, so --fix is a no-op on it.
func TestFixOnAHealthyDataDirRepairsNothing(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	writeFileT(t, registryPath(),
		`{"projects":[{"id":"A1","name":"alpha","path":"`+repo+`"}]}`)
	writeFileT(t, projectConfigJSONPath(proj.ID), `{"defaultBranch":"main"}`)
	invalidateAllWorktreeIdentities()

	report := runDoctorChecks([]project{proj}, true)
	if n := repairableCount(report); n != 0 {
		t.Fatalf("%d repairs offered on a healthy root: %+v", n, report.findings)
	}
	if applied, _ := applyRepairs(report, true); len(applied) != 0 {
		t.Fatalf("--fix did something on a healthy root: %v", applied)
	}
}

// --- data dir pointer ---

func TestIgnoredPointerIsReported(t *testing.T) {
	home := sandboxDataDirEnv(t)
	seedDataDir(t, filepath.Join(home, dataDirName))
	writePointer(t, filepath.Join(home, ".config"), "relative/path\n")
	initDataDirT(t)

	report := &doctorReport{}
	checkDataDir(report)
	finding := onlyFinding(t, report, "data-dir", statusWarn)
	if !strings.Contains(finding.Detail, "isn't an absolute path") {
		t.Fatalf("the detail should say why the pointer was ignored: %s", finding.Detail)
	}
}

func TestDefaultDirLeftBesideAPointedOne(t *testing.T) {
	home := sandboxDataDirEnv(t)
	seedDataDir(t, filepath.Join(home, dataDirName))
	target := filepath.Join(home, "elsewhere")
	seedDataDir(t, target)
	writePointer(t, filepath.Join(home, ".config"), target)
	if got := initDataDirT(t); got != target {
		t.Fatalf("data dir = %s, want the pointer's %s", got, target)
	}

	report := &doctorReport{}
	checkDataDir(report)
	finding := onlyFinding(t, report, "data-dir", statusWarn)
	if !strings.Contains(finding.Detail, "also holds state and is ignored") {
		t.Fatalf("detail: %s", finding.Detail)
	}
}

func TestUnmountedVolume(t *testing.T) {
	for path, want := range map[string]string{
		"/Volumes/no-such-drive-9f3a/sm": "/Volumes/no-such-drive-9f3a",
		"/Users/x/.sm":                   "",
		"/Volumes/":                      "",
	} {
		if got := unmountedVolume(path); got != want {
			t.Errorf("unmountedVolume(%q) = %q, want %q", path, got, want)
		}
	}
}

// --- terrier projects ---

// A terrier project is checked like any other, but the entry is
// terrier's, so a gone directory is never offered for unregistering.
func TestGoneTerrierProjectIsReportedNotUnregistered(t *testing.T) {
	root := sandboxDataDir(t)
	proj := project{ID: "T1", Name: "ghost", Path: filepath.Join(root, "gone"), Source: "terrier"}
	report := &doctorReport{}
	checkProjects(report, []project{proj})
	finding := onlyFinding(t, report, "project-path", statusWarn)
	if finding.repair != nil {
		t.Fatal("a terrier entry must never be unregistered by sm")
	}
	if !strings.Contains(finding.Fix, "terrier prune") {
		t.Fatalf("fix should point at terrier: %s", finding.Fix)
	}
}

func TestTerrierProjectGetsPerProjectChecks(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "T1", Name: "alpha", Path: repo, Source: "terrier"}
	worktree := filepath.Join(root, "worktrees", "alpha", "vanished")
	runGitT(t, repo, "worktree", "add", "-q", "-b", "vanished", worktree)
	if err := os.RemoveAll(worktree); err != nil {
		t.Fatal(err)
	}
	invalidateAllWorktreeIdentities()

	report := &doctorReport{}
	checkProjects(report, []project{proj})
	onlyFinding(t, report, "project-worktrees", statusWarn)
}

func TestUnregisterHintFollowsTheSource(t *testing.T) {
	if got := unregisterHint(project{Name: "a", Source: "terrier"}); !strings.Contains(got, "terrier rm a") {
		t.Errorf("terrier hint = %s", got)
	}
	if got := unregisterHint(project{Name: "a"}); !strings.Contains(got, "projects remove a") {
		t.Errorf("registry hint = %s", got)
	}
}

// --- carry-over ---

func TestCarryOverEntryInNoCheckout(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	writeFileT(t, filepath.Join(repo, ".env"), "X=1")
	invalidateAllWorktreeIdentities()
	config := &projectConfig{CarryOver: []carryOverEntry{{Path: ".env"}, {Path: ".env.local"}}}

	report := &doctorReport{}
	checkProjectCarryOver(report, proj, config)
	finding := onlyFinding(t, report, "project-carryover", statusWarn)
	if !strings.Contains(finding.Detail, ".env.local") || strings.Contains(finding.Detail, ".env,") {
		t.Fatalf("detail should name only the missing entry: %s", finding.Detail)
	}
}

// --- launchers ---

func TestLauncherProgram(t *testing.T) {
	for command, want := range map[string]string{
		"code .":                     "code",
		"/usr/bin/open -a Foo .":     "/usr/bin/open",
		`"/opt/tool" --x`:            "/opt/tool",
		`"/Applications/My App/x" .`: "", // spaces inside quotes: give up
		"FOO=1 claude":               "",
		"$EDITOR .":                  "",
		"cd sub && make":             "",
		"./scripts/dev.sh":           "", // relative to the worktree
		"(cd x; y)":                  "",
		"":                           "",
	} {
		if got := launcherProgram(command); got != want {
			t.Errorf("launcherProgram(%q) = %q, want %q", command, got, want)
		}
	}
}

func TestLaunchersMissingProgram(t *testing.T) {
	got := launchersMissingProgram([]launcherCommand{
		{Label: "shell", Command: "sh -c true"},
		{Label: "ghost", Command: "no-such-program-9f3a --flag"},
		{Label: "abs", Command: "/no/such/binary"},
		{Label: "env", Command: "$EDITOR ."},
	})
	if len(got) != 2 || got[0].label != "ghost" || got[1].label != "abs" {
		t.Fatalf("got %+v, want ghost and abs", got)
	}
}

// --- landing refs ---

func TestStaleIncomingRefsAreRepairable(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	proj := project{ID: "A1", Name: "alpha", Path: repo}
	runGitT(t, repo, "update-ref", "refs/shigomori/incoming/fresh", "HEAD")
	runGitT(t, repo, "update-ref", "refs/shigomori/incoming/feat", "HEAD")
	old := time.Now().Add(-2 * incomingRefStale)
	if err := os.Chtimes(filepath.Join(repo, ".git", "refs", "shigomori", "incoming", "feat"), old, old); err != nil {
		t.Fatal(err)
	}

	report := &doctorReport{}
	checkIncomingRefs(report, proj)
	finding := onlyFinding(t, report, "project-incoming", statusWarn)
	if strings.Contains(finding.Detail, "fresh") {
		t.Fatalf("a landing ref under an hour old may be mid-transfer: %s", finding.Detail)
	}
	if finding.repair == nil || !finding.repair.destructive {
		t.Fatal("deleting a ref must be offered, behind a prompt")
	}
	if err := finding.repair.apply(); err != nil {
		t.Fatal(err)
	}
	if refs := staleIncomingRefs(repo); len(refs) != 0 {
		t.Fatalf("still stale after the repair: %v", refs)
	}
	if _, err := runGit(repo, "rev-parse", "--verify", "refs/shigomori/incoming/fresh"); err != nil {
		t.Fatal("the fresh ref was deleted too")
	}
}

// Packed refs have no mtime, and a pack means a gc has run since.
func TestPackedIncomingRefIsStale(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "alpha")
	runGitT(t, repo, "update-ref", "refs/shigomori/incoming/feat", "HEAD")
	runGitT(t, repo, "pack-refs", "--all")
	if refs := staleIncomingRefs(repo); len(refs) != 1 {
		t.Fatalf("got %v, want the packed ref", refs)
	}
}

// The common case the pointer warning is for: the pointer is refused
// and the default it fell back to has never existed.
func TestIgnoredPointerIsReportedWhenTheDefaultIsMissing(t *testing.T) {
	home := sandboxDataDirEnv(t)
	writePointer(t, filepath.Join(home, ".config"), "relative/path\n")
	initDataDirT(t)

	report := &doctorReport{}
	if checkDataDir(report) {
		t.Fatal("the checks below need a data dir, and there is none")
	}
	finding := onlyFinding(t, report, "data-dir", statusWarn)
	if !strings.Contains(finding.Detail, "pointer file") {
		t.Fatalf("the pointer should be named: %s", finding.Detail)
	}
}

// ~/.sm as a symlink to the pointed-to dir is the same data, not an
// ignored copy to delete.
func TestSymlinkedDefaultIsNotAnIgnoredCopy(t *testing.T) {
	home := sandboxDataDirEnv(t)
	target := filepath.Join(home, "elsewhere")
	seedDataDir(t, target)
	if err := os.Symlink(target, filepath.Join(home, dataDirName)); err != nil {
		t.Fatal(err)
	}
	writePointer(t, filepath.Join(home, ".config"), target)
	initDataDirT(t)

	report := &doctorReport{}
	checkDataDir(report)
	onlyFinding(t, report, "data-dir", statusOK)
}

func TestStagingLockHolderRefusesNonPids(t *testing.T) {
	sandboxDataDir(t)
	for _, content := range []string{"0", "-1", "nope"} {
		writeFileT(t, stagingLockPath(), content)
		if present, pid, alive := stagingLockHolder(); !present || pid != 0 || alive {
			t.Errorf("%q: present %v, pid %d, alive %v", content, present, pid, alive)
		}
	}
}
