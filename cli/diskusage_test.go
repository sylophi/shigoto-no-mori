package main

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// 64 KiB of incompressible bytes: big enough to own whole blocks on any
// filesystem, so footprint and reclaimable are exact multiples of it.
const diskTestSize = 64 << 10

func writeDiskTestFile(t *testing.T, path string, mtime time.Time) {
	t.Helper()
	data := make([]byte, diskTestSize)
	rand.Read(data)
	writeFileT(t, path, string(data))
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func allocatedBytes(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Blocks * 512
}

func TestMeasureDiskUsage(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "tree")
	old := time.UnixMilli(1_700_000_000_000)
	recent := time.UnixMilli(1_750_000_000_000)

	writeDiskTestFile(t, filepath.Join(root, "src", "a.ts"), old)
	// Bytes, but not activity: an install touches every mtime here.
	writeDiskTestFile(t, filepath.Join(root, "node_modules", "pkg", "index.js"), recent)
	// A nested worktree, measured as its own row.
	writeDiskTestFile(t, filepath.Join(root, "nested", "b.ts"), recent)
	// Two links to one inode, both inside: counted once, and freed.
	writeDiskTestFile(t, filepath.Join(root, "inside-a"), old)
	if err := os.Link(filepath.Join(root, "inside-a"), filepath.Join(root, "inside-b")); err != nil {
		t.Fatal(err)
	}
	// A link into a store outside the tree, the way pnpm hard-links
	// packages: on disk, but removing the tree frees none of it.
	writeDiskTestFile(t, filepath.Join(base, "store", "pkg.js"), old)
	if err := os.Link(filepath.Join(base, "store", "pkg.js"), filepath.Join(root, "node_modules", "linked.js")); err != nil {
		t.Fatal(err)
	}
	// A symlink out of the tree is never followed.
	if err := os.Symlink(filepath.Join(base, "store"), filepath.Join(root, "store-link")); err != nil {
		t.Fatal(err)
	}

	usage := measureDiskUsage(root, map[string]bool{filepath.Join(root, "nested"): true})

	file := allocatedBytes(t, filepath.Join(root, "src", "a.ts"))
	link := allocatedBytes(t, filepath.Join(root, "store-link"))
	// Directories' own blocks: none on APFS, a block each on ext4. The
	// excluded one isn't measured at all.
	var dirs int64
	for _, dir := range []string{"", "src", "node_modules", filepath.Join("node_modules", "pkg")} {
		dirs += allocatedBytes(t, filepath.Join(root, dir))
	}
	if want := 4*file + link + dirs; usage.Bytes != want {
		t.Errorf("bytes = %d, want %d", usage.Bytes, want)
	}
	if want := 3*file + link + dirs; usage.ReclaimableBytes != want {
		t.Errorf("reclaimableBytes = %d, want %d", usage.ReclaimableBytes, want)
	}
	if usage.LastActivityAt == nil || *usage.LastActivityAt != old.UnixMilli() {
		t.Errorf("lastActivityAt = %v, want %d", usage.LastActivityAt, old.UnixMilli())
	}
	if usage.Partial {
		t.Error("partial = true for a fully readable tree")
	}
}

// A clone shares every block with its source until either side writes,
// so deleting it frees nothing. Only checkable where cloneTree clones.
func TestMeasureDiskUsageClone(t *testing.T) {
	base := t.TempDir()
	writeDiskTestFile(t, filepath.Join(base, "source", "pkg.js"), time.Now())
	root := filepath.Join(base, "tree")
	if err := cloneTree(filepath.Join(base, "source"), root); err != nil {
		t.Skipf("no clone support here: %v", err)
	}
	if _, ok := privateSize(filepath.Join(root, "pkg.js")); !ok {
		t.Skip("the volume reports no private size")
	}

	usage := measureDiskUsage(root, nil)

	if want := allocatedBytes(t, filepath.Join(root, "pkg.js")); usage.Bytes != want {
		t.Errorf("bytes = %d, want %d", usage.Bytes, want)
	}
	if usage.ReclaimableBytes != 0 {
		t.Errorf("reclaimableBytes = %d, want 0", usage.ReclaimableBytes)
	}
}

func TestMeasureDiskUsageMissingRoot(t *testing.T) {
	usage := measureDiskUsage(filepath.Join(t.TempDir(), "gone"), nil)
	if !usage.Partial || usage.Bytes != 0 || usage.LastActivityAt != nil {
		t.Errorf("got %+v, want an empty partial result", usage)
	}
}
