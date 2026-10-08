//go:build darwin

// macfs: the macOS filesystem calls Node has no binding for, for the
// engine's Darwin service. Six verbs:
//
//	macfs clone [-stdin] <src> <dst>   clonefile(2) a tree, mode and mtime kept
//	macfs flags [-stdin] [-clear] <root>   st_flags, the owner's cleared but compression and tracking
//	macfs xattrs [-stdin] [-strip] <root>  xattr names, stripped but provenance
//	macfs privsize [-stdin] <root>     APFS private size, null where unknown
//	macfs fstype [-stdin] <root>       the filesystem's type name
//	macfs lstat [-stdin] <root>        lstat(2): what git's index records, and the flags
//
// Without -stdin, clone and fstype answer for the root itself and the
// other four walk the whole tree under it (the root included, no
// symlink followed). With -stdin they answer for the NUL-separated
// paths on stdin, each relative to the root (clone: under both roots).
// A clone's destination must not exist, and its parent must.
//
// Every entry is one NDJSON line on stdout, in no particular order,
// keyed by its path relative to the root ("." for the root):
//
//	{"path":"a/b","flags":32}
//	{"path":"a/c","error":{"code":"ENOENT","message":"no such file or directory"}}
//
// With -clear or -strip a line reports the flags or names as found,
// before they went.
// A directory a walk can't list adds an error line under its own path.
// Exit status 0 means every entry was answered, 2 a usage error, 1 a
// failure reading stdin or writing stdout.
package main

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"golang.org/x/sys/unix"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

type cloned struct {
	Path string `json:"path"`
}

type flagged struct {
	Path  string `json:"path"`
	Flags uint32 `json:"flags"`
}

type attributed struct {
	Path  string   `json:"path"`
	Names []string `json:"names"`
}

type sized struct {
	Path  string `json:"path"`
	Bytes *int64 `json:"bytes"`
}

// An entry's lstat(2), each time to the nanosecond: the fields git's
// index records and compares, and the file flags.
type statted struct {
	Path string `json:"path"`
	// As git's index stores it: 32 bits.
	Dev       uint32 `json:"dev"`
	Ino       uint64 `json:"ino"`
	Mode      uint32 `json:"mode"`
	UID       uint32 `json:"uid"`
	GID       uint32 `json:"gid"`
	Size      int64  `json:"size"`
	CtimeSec  int64  `json:"ctimeSec"`
	CtimeNsec int64  `json:"ctimeNsec"`
	MtimeSec  int64  `json:"mtimeSec"`
	MtimeNsec int64  `json:"mtimeNsec"`
	Flags     uint32 `json:"flags"`
}

type typed struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type failed struct {
	Path  string     `json:"path"`
	Error entryError `json:"error"`
}

type entryError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func failure(rel string, err error) failed {
	var errno unix.Errno
	if errors.As(err, &errno) {
		return failed{rel, entryError{unix.ErrnoName(errno), errno.Error()}}
	}
	return failed{rel, entryError{"", err.Error()}}
}

// What a verb does for one entry, given the roots and the entry's path
// relative to them.
type op func(roots []string, rel string) (any, error)

type verb struct {
	roots int
	walks bool
	op    func(set *flag.FlagSet) op
}

var verbs = map[string]verb{
	"clone": {roots: 2, op: func(*flag.FlagSet) op {
		return func(roots []string, rel string) (any, error) {
			return cloned{rel}, cloneTree(filepath.Join(roots[0], rel), filepath.Join(roots[1], rel))
		}
	}},
	"flags": {roots: 1, walks: true, op: func(set *flag.FlagSet) op {
		clear := set.Bool("clear", false, "clear the owner's flags but compression and tracking")
		return func(roots []string, rel string) (any, error) {
			p := filepath.Join(roots[0], rel)
			flags, err := fileFlags(p)
			if err == nil && *clear {
				err = clearFlags(p, flags)
			}
			return flagged{rel, flags}, err
		}
	}},
	"xattrs": {roots: 1, walks: true, op: func(set *flag.FlagSet) op {
		strip := set.Bool("strip", false, "remove every attribute but provenance")
		return func(roots []string, rel string) (any, error) {
			p := filepath.Join(roots[0], rel)
			names, err := listXattrs(p)
			if err == nil && *strip {
				err = stripXattrs(p, names)
			}
			return attributed{rel, names}, err
		}
	}},
	"privsize": {roots: 1, walks: true, op: func(*flag.FlagSet) op {
		return func(roots []string, rel string) (any, error) {
			out := sized{Path: rel}
			n, ok, err := privateSize(filepath.Join(roots[0], rel))
			if ok {
				out.Bytes = &n
			}
			return out, err
		}
	}},
	"lstat": {roots: 1, walks: true, op: func(*flag.FlagSet) op {
		return func(roots []string, rel string) (any, error) {
			var st unix.Stat_t
			if err := unix.Lstat(filepath.Join(roots[0], rel), &st); err != nil {
				return nil, err
			}
			return statted{
				Path: rel, Dev: uint32(st.Dev), Ino: st.Ino, Mode: uint32(st.Mode),
				UID: st.Uid, GID: st.Gid, Size: st.Size,
				CtimeSec: st.Ctim.Sec, CtimeNsec: st.Ctim.Nsec,
				MtimeSec: st.Mtim.Sec, MtimeNsec: st.Mtim.Nsec,
				Flags: st.Flags,
			}, nil
		}
	}},
	"fstype": {roots: 1, op: func(*flag.FlagSet) op {
		return func(roots []string, rel string) (any, error) {
			name, err := fsType(filepath.Join(roots[0], rel))
			return typed{rel, name}, err
		}
	}},
}

const usage = "usage: macfs clone|flags|xattrs|privsize|fstype|lstat [-stdin] [-clear|-strip] <root> [<dst>]"

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	v, ok := verbs[args[0]]
	if !ok {
		fmt.Fprintf(stderr, "macfs: unknown verb %q\n%s\n", args[0], usage)
		return 2
	}
	set := flag.NewFlagSet("macfs "+args[0], flag.ContinueOnError)
	set.SetOutput(stderr)
	fromStdin := set.Bool("stdin", false, "answer for the NUL-separated relative paths on stdin")
	do := v.op(set)
	if err := set.Parse(args[1:]); err != nil {
		return 2
	}
	roots := set.Args()
	if len(roots) != v.roots {
		fmt.Fprintln(stderr, usage)
		return 2
	}

	// Paths go to a pool of workers, whose lines one writer encodes.
	paths := make(chan string, 256)
	lines := make(chan any, 64)
	var workers sync.WaitGroup
	for range runtime.NumCPU() * 2 {
		workers.Go(func() {
			for rel := range paths {
				out, err := do(roots, rel)
				if err != nil {
					out = failure(rel, err)
				}
				lines <- out
			}
		})
	}
	written := make(chan error, 1)
	go func() { written <- write(stdout, lines) }()

	var readErr error
	switch {
	case *fromStdin:
		readErr = readPaths(stdin, paths)
	case v.walks:
		walk(roots[0], paths, lines)
	default:
		paths <- "."
	}
	close(paths)
	workers.Wait()
	close(lines)
	writeErr := <-written

	if err := cmp.Or(readErr, writeErr); err != nil {
		fmt.Fprintf(stderr, "macfs: %v\n", err)
		return 1
	}
	return 0
}

// Sends every entry under root, root included, without following a
// symlink.
func walk(root string, paths chan<- string, lines chan<- any) {
	_ = filepath.WalkDir(root, func(p string, _ fs.DirEntry, err error) error {
		rel, _ := filepath.Rel(root, p)
		if err != nil {
			lines <- failure(rel, err)
			return nil
		}
		paths <- rel
		return nil
	})
}

func readPaths(stdin io.Reader, paths chan<- string) error {
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(nil, 1<<20)
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if i := bytes.IndexByte(data, 0); i >= 0 {
			return i + 1, data[:i], nil
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for scanner.Scan() {
		if rel := scanner.Text(); rel != "" {
			paths <- rel
		}
	}
	return scanner.Err()
}

// Encodes each line as it comes, flushing whenever none is waiting so
// the reader sees results while the rest are still being worked out.
func write(stdout io.Writer, lines <-chan any) error {
	buf := bufio.NewWriter(stdout)
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	var err error
	for line := range lines {
		if err != nil {
			continue
		}
		if err = enc.Encode(line); err == nil && len(lines) == 0 {
			err = buf.Flush()
		}
	}
	if err != nil {
		return err
	}
	return buf.Flush()
}
