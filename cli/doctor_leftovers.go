package main

// Doctor checks for what a crash leaves behind outside sm's own state
// files: processes the app started that outlived it, update downloads
// nothing will sweep until the next update, and an app bundle an
// interrupted update set aside. Read-only like doctor_checks.go. The
// processes are only reported: the app stops both kinds at its next
// launch, and killing a process is not a repair doctor guesses at.

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Electron's userData for this flavor (app/main/index.ts gives dev its
// own suffix). Dev profiles nest their own and aren't looked at.
func appUserDataDir() string {
	home, err := os.UserHomeDir()
	if runtime.GOOS != "darwin" || err != nil {
		return ""
	}
	name := appExecutableName
	if flavor != "prod" {
		name += " (dev)"
	}
	return filepath.Join(home, "Library", "Application Support", name)
}

// The app records its cloudflared child's pid (cloudflared.pid in
// userData) and kills a leftover one at its next launch. Until that
// launch, a tunnel whose app crashed keeps this Mac reachable, which
// the app accepts as residual exposure. Doctor is where it gets said.
func checkOrphanTunnel(report *doctorReport) {
	userData := appUserDataDir()
	if userData == "" {
		return
	}
	raw, err := os.ReadFile(filepath.Join(userData, "cloudflared.pid"))
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid < 2 {
		return
	}
	stdout, err := exec.Command("ps", "-o", "ppid=,comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return // gone, which is the ordinary case
	}
	ppid, comm, _ := strings.Cut(strings.TrimSpace(string(stdout)), " ")
	// Reparented to launchd is what outliving the app looks like. With
	// the app alive it is the app's child, and the app's business.
	if !strings.Contains(strings.ToLower(comm), "cloudflared") || strings.TrimSpace(ppid) != "1" {
		return
	}
	report.warn(groupProcesses, "tunnel", "tunnel",
		fmt.Sprintf("a cloudflared tunnel (pid %d) outlived the app that started it, so this Mac stays reachable through it", pid),
		fmt.Sprintf("Open the app, which stops it at launch, or run `kill %d`.", pid))
}

// running-scripts.json (app/host/lib/scripts/persistence.ts): the dev
// servers and scripts the app started, with the app instance that owns
// them. The app stops a dead owner's survivors at its next launch, and
// until then they hold their ports.
type runningScriptsFile struct {
	OwnerPid int `json:"ownerPid"`
	Scripts  []struct {
		Pid       int    `json:"pid"`
		StartedAt int64  `json:"startedAt"`
		Command   string `json:"command"`
	} `json:"scripts"`
}

// ps reports a start time to the second, stamped just after spawn, so
// the two differ by that rounding plus spawn latency. Same tolerance
// as the app's sweep.
const scriptStartTolerance = 5 * time.Second

func checkOrphanScripts(report *doctorReport) {
	file, ok := readJSONFile[runningScriptsFile](filepath.Join(dataDir(), "running-scripts.json"))
	if !ok || len(file.Scripts) == 0 || file.OwnerPid < 2 || pidAlive(file.OwnerPid) {
		return
	}
	var pids []string
	for _, s := range file.Scripts {
		if s.Pid >= 2 {
			pids = append(pids, strconv.Itoa(s.Pid))
		}
	}
	if len(pids) == 0 {
		return
	}
	cmd := exec.Command("ps", "-p", strings.Join(pids, ","), "-o", "pid=,lstart=")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	stdout, _ := cmd.Output() // non-zero when none are alive
	live := parseProcessTable(string(stdout))
	var orphans []string
	var orphanPids []string
	for _, s := range file.Scripts {
		started, found := live[s.Pid]
		// A recycled pid started at another time. The app's sweep, which
		// kills, asks for more proof. A report doesn't need it.
		if !found || absDuration(started.Sub(time.UnixMilli(s.StartedAt))) > scriptStartTolerance {
			continue
		}
		orphans = append(orphans, s.Command)
		orphanPids = append(orphanPids, strconv.Itoa(s.Pid))
	}
	if len(orphans) == 0 {
		return
	}
	report.warn(groupProcesses, "scripts", "scripts",
		fmt.Sprintf("%d script%s the app started %s still running after it quit (%s), holding %s ports",
			len(orphans), plural(len(orphans)), pluralize(len(orphans), "is", "are"),
			strings.Join(orphans, ", "), pluralize(len(orphans), "its", "their")),
		"Open the app, which stops them at launch, or run `kill "+strings.Join(orphanPids, " ")+"`.")
}

// "  1234 Mon Aug 17 18:42:41 2026": each pid's start time.
var psLine = regexp.MustCompile(`^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*$`)

func parseProcessTable(stdout string) map[int]time.Time {
	table := map[int]time.Time{}
	for _, line := range strings.Split(stdout, "\n") {
		m := psLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		started, err := time.ParseInLocation("Mon Jan _2 15:04:05 2006", strings.Join(strings.Fields(m[2]), " "), time.Local)
		if err != nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		table[pid] = started
	}
	return table
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// A crashed or superseded update run leaves its scratch space
// (download.zip, extract/) until the next update sweeps it, and a
// staged bundle this build already is (or is newer than) will never be
// installed. Each can be a few hundred MB. Only while no stager holds
// the lock: mid-run, these are its working files.
func checkUpdateLeftovers(report *doctorReport) {
	if _, _, alive := stagingLockHolder(); alive {
		return
	}
	paths := updateLeftoverPaths()
	if len(paths) == 0 {
		return
	}
	var size int64
	for _, path := range paths {
		size += treeSize(path)
	}
	report.repairable(groupState, "update-leftovers", "update files", statusWarn,
		fmt.Sprintf("%s of downloads left by an earlier update that nothing will install", formatSize(size)),
		"Delete them, or let the next update sweep them.",
		&repair{
			prompt:      "Delete " + formatSize(size) + " of leftover update files in " + collapseHome(updatesDir()) + "?",
			label:       "deleted " + formatSize(size) + " of leftover update files",
			destructive: true,
			apply: func() error {
				// Under the stager's own lock, and re-listed once it's held:
				// a run that staged something newer since the report must
				// not lose it.
				unlock, err := acquireStagingLock()
				if err != nil {
					return err
				}
				defer unlock()
				for _, path := range updateLeftoverPaths() {
					if err := os.RemoveAll(path); err != nil {
						return err
					}
				}
				return nil
			},
		})
}

// The scratch a staging run left, plus a staged bundle this build
// already is or is newer than. An unparseable version on either side
// reads as "can't tell", never as a leftover.
func updateLeftoverPaths() []string {
	var paths []string
	for _, path := range updateScratchPaths() {
		if pathExists(path) {
			paths = append(paths, path)
		}
	}
	if man, ok := readJSONFile[stagedManifest](stagedManifestPath()); ok {
		_, okStaged := parseSemver(man.Version)
		_, okCurrent := parseSemver(version)
		if okStaged && okCurrent && !newerThanThisBuild(man.Version) {
			paths = append(paths, stagedDir())
		}
	}
	return paths
}

// The swap sets the installed app aside before renaming the new one
// in. A crash between the two leaves the aside copy as the only app,
// which reads as "the app is gone".
func findAsideBundle() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	for _, dir := range appRoots() {
		matches, _ := filepath.Glob(filepath.Join(dir, asideBundleName(appExecutableName+".app", "*")))
		if len(matches) > 0 {
			return matches[0]
		}
	}
	return ""
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func treeSize(root string) int64 {
	var size int64
	_ = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if info, err := entry.Info(); err == nil {
				size += info.Size()
			}
		}
		return nil
	})
	return size
}

func formatSize(bytes int64) string {
	switch {
	case bytes >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(bytes)/(1<<30))
	case bytes >= 1<<20:
		return fmt.Sprintf("%d MB", bytes>>20)
	case bytes >= 1<<10:
		return fmt.Sprintf("%d KB", bytes>>10)
	}
	return fmt.Sprintf("%d bytes", bytes)
}
