package main

// The process calls Node has no binding for on Windows, where no ps
// tells a process's parent, birth or command line. Two verbs:
//
//	nativefs processes [<pid>...]         every process, those named with their command lines
//	nativefs end [<pid>:<birth>...]       each process still the one born then, and all it started, ended
//
// processes prints one NDJSON line per process, in no particular order:
//
//	{"pid":1234,"parent":1000,"birth":1794609084082,"name":"node.exe","command":"node server.js"}
//
// birth is when it started, in epoch milliseconds. parent is 0 once the
// process that started it is gone: Windows keeps a dead parent's pid,
// which another process may hold by then, and a parent is born before
// its child. command is absent where it can't be read.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var processVerbs = map[string]func(args []string, stdout, stderr io.Writer) int{
	"processes": listProcesses,
	"end":       endProcesses,
}

type process struct {
	Pid     uint32  `json:"pid"`
	Parent  uint32  `json:"parent"`
	Birth   int64   `json:"birth"`
	Name    string  `json:"name"`
	Command *string `json:"command,omitempty"`
	// The birth as Windows keeps it, in 100 ns ticks, which tells a
	// parent from a child born the same millisecond.
	created int64
}

// The 100 ns ticks from 1601 to 1970.
const unixEpochTicks = 116444736000000000

// Every process, read in one call, so the table is one moment's.
func snapshot() (map[uint32]*process, error) {
	var buf []byte
	size := uint32(1 << 20)
	for {
		buf = make([]byte, size)
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&buf[0]), size, &size)
		if errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) {
			// More processes may start before the next try.
			size += 64 << 10
			continue
		}
		if err != nil {
			return nil, err
		}
		break
	}
	table := map[uint32]*process{}
	for at := uint32(0); ; {
		info := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&buf[at]))
		// Pid 0 is the idle process, born at no time.
		if pid := uint32(info.UniqueProcessID); pid != 0 {
			table[pid] = &process{
				Pid:     pid,
				Parent:  uint32(info.InheritedFromUniqueProcessID),
				Birth:   (info.CreateTime - unixEpochTicks) / 10_000,
				Name:    info.ImageName.String(),
				created: info.CreateTime,
			}
		}
		if info.NextEntryOffset == 0 {
			break
		}
		at += info.NextEntryOffset
	}
	for _, p := range table {
		if parent, ok := table[p.Parent]; !ok || parent.created >= p.created {
			p.Parent = 0
		}
	}
	return table, nil
}

// A handle to p with `access`, while its pid still names p.
func open(p *process, access uint32) (windows.Handle, bool) {
	h, err := windows.OpenProcess(access|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, p.Pid)
	if err != nil {
		return 0, false
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil ||
		int64(created.HighDateTime)<<32|int64(created.LowDateTime) != p.created {
		windows.CloseHandle(h)
		return 0, false
	}
	return h, true
}

func commandLine(p *process) (string, bool) {
	h, ok := open(p, 0)
	if !ok {
		return "", false
	}
	defer windows.CloseHandle(h)
	// A command line is at most 32K characters.
	for size := uint32(4 << 10); ; size *= 2 {
		buf := make([]byte, size)
		err := windows.NtQueryInformationProcess(h, windows.ProcessCommandLineInformation, unsafe.Pointer(&buf[0]), size, nil)
		if errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) {
			continue
		}
		if err != nil {
			return "", false
		}
		return (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0])).String(), true
	}
}

func listProcesses(args []string, stdout, stderr io.Writer) int {
	named := map[uint32]bool{}
	for _, arg := range args {
		pid, err := strconv.ParseUint(arg, 10, 32)
		if err != nil {
			fmt.Fprintf(stderr, "nativefs processes: not a pid: %q\n", arg)
			return 2
		}
		named[uint32(pid)] = true
	}
	table, err := snapshot()
	if err != nil {
		fmt.Fprintf(stderr, "nativefs processes: %v\n", err)
		return 1
	}
	out := bufio.NewWriter(stdout)
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	for _, p := range table {
		if named[p.Pid] {
			if command, ok := commandLine(p); ok {
				p.Command = &command
			}
		}
		if err := enc.Encode(p); err != nil {
			fmt.Fprintf(stderr, "nativefs processes: %v\n", err)
			return 1
		}
	}
	if err := out.Flush(); err != nil {
		fmt.Fprintf(stderr, "nativefs processes: %v\n", err)
		return 1
	}
	return 0
}

// Every handle is open before any process is ended, and each was
// checked to be the process the table read, so no pid in the tree can
// pass to another process meanwhile.
func endProcesses(args []string, _, stderr io.Writer) int {
	type member struct {
		pid   uint32
		birth int64
	}
	var roots []member
	for _, arg := range args {
		pid, birth, ok := strings.Cut(arg, ":")
		p, perr := strconv.ParseUint(pid, 10, 32)
		b, berr := strconv.ParseInt(birth, 10, 64)
		if !ok || perr != nil || berr != nil {
			fmt.Fprintf(stderr, "nativefs end: not a pid:birth: %q\n", arg)
			return 2
		}
		roots = append(roots, member{uint32(p), b})
	}
	table, err := snapshot()
	if err != nil {
		fmt.Fprintf(stderr, "nativefs end: %v\n", err)
		return 1
	}
	children := map[uint32][]*process{}
	for _, p := range table {
		if p.Parent != 0 {
			children[p.Parent] = append(children[p.Parent], p)
		}
	}
	var tree []*process
	seen := map[uint32]bool{}
	var add func(p *process)
	add = func(p *process) {
		if seen[p.Pid] {
			return
		}
		seen[p.Pid] = true
		tree = append(tree, p)
		for _, child := range children[p.Pid] {
			add(child)
		}
	}
	for _, root := range roots {
		if p, ok := table[root.pid]; ok && p.Birth == root.birth {
			add(p)
		}
	}
	var handles []windows.Handle
	for _, p := range tree {
		if h, ok := open(p, windows.PROCESS_TERMINATE); ok {
			handles = append(handles, h)
		}
	}
	// Parents first, so none starts another child as its own end nears.
	for _, h := range handles {
		_ = windows.TerminateProcess(h, 1)
		windows.CloseHandle(h)
	}
	return 0
}
