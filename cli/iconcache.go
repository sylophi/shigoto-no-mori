package main

// The project icon cache: iconCache/index.json under the data dir,
// keyed by project path, so a resolved project never pays the git
// scan again, and the accent hue rides along with the icon entry. The
// CLI owns resolution and this cache: the app reads icons through
// `sm projects list --json` (path, mime, hue) and `sm projects icon`
// (the bytes). The app's host/lib/projects/icon.ts still writes the
// same file until it is removed, which is why every read-modify-write
// merges under index.json.lock (the state.json protocol) and why the
// schema below still matches its IconCacheEntry.
//
// Schema:
//   sourcePath     absolute icon path, or "" for "resolved to no
//                  icon". Negative entries are CLI-only: the app
//                  skips them (a freshly added icon must show up in
//                  the sidebar immediately) but preserves them, and
//                  the CLI re-scans once they outlive iconMissTTL.
//   sourceHash/sourceSize/sourceMtimeMs  revalidation, app-compatible
//   mime           for the app's data URLs
//   updatedAt      ms epoch of the write (drives the miss TTL)
//   hue            OKLCH hue degrees of the icon's dominant chroma;
//                  achromaticHue (-1) = icon has no usable color;
//                  absent = not computed yet. Written by the CLI; the
//                  app keeps it on touch-only revalidation and drops
//                  it when the content hash changes.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	achromaticHue = float64(-1)
	iconMissTTL   = 24 * time.Hour
	maxIconBytes  = 2 << 20
)

type iconCacheEntry struct {
	SourcePath    string   `json:"sourcePath"`
	SourceHash    string   `json:"sourceHash,omitempty"`
	SourceSize    int64    `json:"sourceSize,omitempty"`
	SourceMtimeMs float64  `json:"sourceMtimeMs,omitempty"`
	Mime          string   `json:"mime,omitempty"`
	UpdatedAt     int64    `json:"updatedAt"`
	Hue           *float64 `json:"hue,omitempty"`
}

var mimeByExt = map[string]string{
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

func mimeForPath(path string) string {
	if mime, ok := mimeByExt[filepath.Ext(path)]; ok {
		return mime
	}
	return "application/octet-stream"
}

func iconCachePath() string {
	return filepath.Join(dataDir(), "iconCache", "index.json")
}

func readIconCache() map[string]iconCacheEntry {
	index := map[string]iconCacheEntry{}
	raw, err := os.ReadFile(iconCachePath())
	if err != nil {
		return index
	}
	// A corrupt index is a cache, not state: start fresh.
	_ = json.Unmarshal(raw, &index)
	return index
}

// One snapshot per invocation; queued updates are merged on flush, so
// a stale snapshot only costs recomputation, never corruption.
var cachedIconIndex = sync.OnceValue(readIconCache)

var (
	iconPendingMu sync.Mutex
	iconPending   map[string]iconCacheEntry
)

func queueIconCacheUpdate(projectPath string, entry iconCacheEntry) {
	iconPendingMu.Lock()
	defer iconPendingMu.Unlock()
	if iconPending == nil {
		iconPending = map[string]iconCacheEntry{}
	}
	iconPending[projectPath] = entry
}

// Merge queued entries into the shared index under its lock.
// Best-effort: the cache is an optimization, so a failed write only
// costs the next run a re-resolve.
func flushIconCache() {
	iconPendingMu.Lock()
	pending := iconPending
	iconPending = nil
	iconPendingMu.Unlock()
	if len(pending) == 0 {
		return
	}
	_ = withFileLock(iconCachePath(), func() error {
		index := readIconCache()
		maps.Copy(index, pending)
		return atomicWriteJSON(iconCachePath(), index)
	})
}

// Fractional ms exactly like Node's stat.mtimeMs, so entries written
// by either surface revalidate cleanly on the other.
func mtimeMs(info os.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1e6
}

// Build a complete cache entry from the icon file: one read feeds
// both the hash and the hue. Oversized icons keep their entry (the
// app still serves them) but are marked achromatic rather than
// decoded.
func buildIconEntry(sourcePath string) (iconCacheEntry, bool) {
	info, err := os.Stat(sourcePath)
	if err != nil {
		return iconCacheEntry{}, false
	}
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return iconCacheEntry{}, false
	}
	hue := achromaticHue
	if info.Size() <= maxIconBytes {
		if h, ok := iconHueBytes(data); ok {
			hue = h
		}
	}
	sum := sha256.Sum256(data)
	return iconCacheEntry{
		SourcePath:    sourcePath,
		SourceHash:    hex.EncodeToString(sum[:]),
		SourceSize:    info.Size(),
		SourceMtimeMs: mtimeMs(info),
		Mime:          mimeForPath(sourcePath),
		UpdatedAt:     time.Now().UnixMilli(),
		Hue:           &hue,
	}, true
}

func accentFrom(hue float64) (float64, bool) {
	if hue < 0 {
		return 0, false
	}
	return hue, true
}

// The accent hue for a project, resolving and revalidating through
// the shared cache. false = no accent (no icon, or a monochrome one).
func projectHue(proj project) (float64, bool) {
	entry, ok := projectIcon(proj, false)
	if !ok {
		return 0, false
	}
	return accentFrom(*entry.Hue)
}

// The project's icon as a complete cache entry (source path, mime,
// hue always set), resolving and revalidating through the shared
// cache; false when the project has no icon. Steady state is one stat
// per project; everything heavier (git scan, image decode, hashing)
// happens once and lands back in the cache (queued; the caller
// flushes). rescanMisses ignores cached "no icon" answers, for a
// caller that must notice an icon added since (the app's sidebar,
// which used to re-resolve icon-less projects every session).
func projectIcon(proj project, rescanMisses bool) (iconCacheEntry, bool) {
	if entry, ok := cachedIconIndex()[proj.Path]; ok {
		if entry.SourcePath == "" {
			if !rescanMisses && time.Since(time.UnixMilli(entry.UpdatedAt)) < iconMissTTL {
				return iconCacheEntry{}, false
			}
			// Expired or ignored miss: fall through to a fresh scan.
		} else if info, err := os.Stat(entry.SourcePath); err == nil {
			unchanged := info.Size() == entry.SourceSize &&
				math.Abs(mtimeMs(info)-entry.SourceMtimeMs) < 0.001
			if unchanged && entry.Hue != nil {
				if entry.Mime == "" {
					entry.Mime = mimeForPath(entry.SourcePath)
				}
				return entry, true
			}
			// Touched, changed, or resolved without a hue yet: rebuild
			// the entry from the bytes and write it back.
			if rebuilt, ok := buildIconEntry(entry.SourcePath); ok {
				queueIconCacheUpdate(proj.Path, rebuilt)
				return rebuilt, true
			}
			// Vanished mid-flight: fall through to a fresh scan.
		}
	}
	sourcePath := resolveIconPath(proj.Path)
	if sourcePath == "" {
		queueIconCacheUpdate(proj.Path, iconCacheEntry{UpdatedAt: time.Now().UnixMilli()})
		return iconCacheEntry{}, false
	}
	entry, ok := buildIconEntry(sourcePath)
	if !ok {
		return iconCacheEntry{}, false
	}
	queueIconCacheUpdate(proj.Path, entry)
	return entry, true
}
