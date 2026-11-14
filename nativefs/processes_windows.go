package main

// The process calls Node has no binding for on Windows, where no ps
// tells a process's parent, birth or command line. Three verbs:
//
//	nativefs processes [<pid>...]         every process, those named with their command lines
//	nativefs end [<pid>:<birth>...]       each process still the one born then, and all it started, ended
//	nativefs job <program> [<arg>...]     the program run to its exit in a job of its own, its exit code the helper's
//
// processes prints one NDJSON line per process, in no particular order:
//
//	{"pid":1234,"parent":1000,"birth":1794609084082,"name":"node.exe","command":"node server.js"}
//
// birth is when it started, in epoch milliseconds. parent is 0 once the
// process that started it is gone: Windows keeps a dead parent's pid,
// which another process may hold by then, and a parent is born before
// its child. console is the pid of the console host (conhost.exe, or
// OpenConsole.exe) of the console it is attached to, absent for none.
// command is absent where it can't be read.

import (
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
	"job":       runInJob,
}

type process struct {
	Pid     uint32  `json:"pid"`
	Parent  uint32  `json:"parent"`
	Birth   int64   `json:"birth"`
	Name    string  `json:"name"`
	Console uint32  `json:"console,omitempty"`
	Command *string `json:"command,omitempty"`
	// The birth as Windows keeps it, to 100 ns, which tells a parent
	// from a child born the same millisecond.
	created windows.Filetime
}

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
			created := windows.Filetime{LowDateTime: uint32(info.CreateTime), HighDateTime: uint32(info.CreateTime >> 32)}
			table[pid] = &process{
				Pid:     pid,
				Parent:  uint32(info.InheritedFromUniqueProcessID),
				Birth:   created.Nanoseconds() / 1e6,
				Name:    info.ImageName.String(),
				created: created,
			}
		}
		if info.NextEntryOffset == 0 {
			break
		}
		at += info.NextEntryOffset
	}
	for _, p := range table {
		if parent, ok := table[p.Parent]; !ok || parent.created.Nanoseconds() >= p.created.Nanoseconds() {
			p.Parent = 0
		}
		if host, ok := table[consoleHostOf(p)]; ok && consoleHosts[strings.ToLower(host.Name)] {
			p.Console = host.Pid
		}
	}
	return table, nil
}

var consoleHosts = map[string]bool{"conhost.exe": true, "openconsole.exe": true}

// The pid Windows keeps as the host of p's console, its low two bits
// flags. A process with no console may name another process there,
// which is no console host.
func consoleHostOf(p *process) uint32 {
	h, ok := open(p, 0)
	if !ok {
		return 0
	}
	defer windows.CloseHandle(h)
	var host uintptr
	if windows.NtQueryInformationProcess(h, windows.ProcessConsoleHostProcess, unsafe.Pointer(&host), uint32(unsafe.Sizeof(host)), nil) != nil {
		return 0
	}
	return uint32(host &^ 3)
}

// A handle to p with `access`, while its pid still names p.
func open(p *process, access uint32) (windows.Handle, bool) {
	h, err := windows.OpenProcess(access|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, p.Pid)
	if err != nil {
		return 0, false
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil || created != p.created {
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
	lines := make(chan any, len(table))
	for _, p := range table {
		if named[p.Pid] {
			if command, ok := commandLine(p); ok {
				p.Command = &command
			}
		}
		lines <- p
	}
	close(lines)
	if err := write(stdout, lines); err != nil {
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

// Runs the program in a job of its own, which holds everything the
// program starts, whatever its parent (Git Bash's forked commands run
// with theirs gone). The job has no name and its handle isn't
// inherited, so the helper holds its one handle, and it ends what is
// in it as that handle closes: the helper's end, however it comes,
// ends the whole tree and nothing outside it. The program's own exit
// lets the job go first, so what it left running outlives it, as a
// script's background process outlives the script elsewhere.
func runInJob(args []string, _, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "nativefs job: no program")
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintf(stderr, "nativefs job: %v\n", err)
		return 1
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fail(err)
	}
	if err := limitJob(job, windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE); err != nil {
		return fail(err)
	}
	program, err := windows.UTF16PtrFromString(args[0])
	if err != nil {
		return fail(err)
	}
	line, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err != nil {
		return fail(err)
	}
	si := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Flags: windows.STARTF_USESTDHANDLES}
	si.StdInput, _ = windows.GetStdHandle(windows.STD_INPUT_HANDLE)
	si.StdOutput, _ = windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	si.StdErr, _ = windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	var pi windows.ProcessInformation
	// Suspended until it is in the job, so nothing it starts is born
	// outside. It inherits the standard handles, the environment and the
	// working folder the helper was given, and the helper's console.
	if err := windows.CreateProcess(program, line, nil, nil, true, windows.CREATE_SUSPENDED, nil, nil, &si, &pi); err != nil {
		return fail(err)
	}
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		return fail(err)
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		return fail(err)
	}
	windows.CloseHandle(pi.Thread)
	if _, err := windows.WaitForSingleObject(pi.Process, windows.INFINITE); err != nil {
		return fail(err)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return fail(err)
	}
	if err := limitJob(job, 0); err != nil {
		fmt.Fprintf(stderr, "nativefs job: %v\n", err)
	}
	return int(code)
}

func limitJob(job windows.Handle, flags uint32) error {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = flags
	_, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	return err
}
