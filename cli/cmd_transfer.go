package main

// The cross-device verbs. Two ideas, each with a direction:
//
//	send   [<name>] --to <device>       move a worktree to another device
//	bring  <worktree> --from <device>   move one of theirs here
//	mirror [<name>] --to <device>       keep a copy of it in step there
//	mirror <worktree> --from <device>   keep a copy of theirs in step here
//
// plus unmirror, mirrors and devices. They run in the app (control.go
// says why), which takes them through the same transplant and mirror
// orchestrators its own dialogs use, so a run from a terminal and one
// from the app's "Transplant to…" are the same run. Names resolve the
// way a person says them: a device by its name, a peer's worktree by
// its folder name or branch. With one device that qualifies, --to can
// be left off.

import (
	"encoding/json"
	"fmt"
	"strings"
)

type controlNamedDevice struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
}

// The slice of the app's Worktree document a terminal reports.
type controlWorktree struct {
	Name   string `json:"name"`
	Branch string `json:"branch"`
	Path   string `json:"path"`
}

type controlTransferResult struct {
	Worktree     controlWorktree    `json:"worktree"`
	Captured     bool               `json:"captured"`
	DirtyApplied bool               `json:"dirtyApplied"`
	Device       controlNamedDevice `json:"device"`
	CopySide     string             `json:"copySide"`
	Already      bool               `json:"alreadyMirrored,omitempty"`
	Files        *struct {
		Crossed bool   `json:"crossed"`
		Error   string `json:"error,omitempty"`
	} `json:"files,omitempty"`
	Source *struct {
		Fate  string `json:"fate"`
		Done  bool   `json:"done"`
		Error string `json:"error,omitempty"`
	} `json:"source,omitempty"`
}

// What became of a source whose fate was carried out.
var sourceFateDone = map[string]string{"shelve": "shelved", "teardown": "removed"}

// The work landed, but something that should have followed it didn't:
// the uncommitted changes weren't applied on the copy, the ignored
// files didn't cross, or the source's fate couldn't be carried out.
func (r controlTransferResult) caveats() []string {
	// Never nil: --json reports "caveats": [] for a clean run.
	caveats := []string{}
	if r.Captured && !r.DirtyApplied {
		caveats = append(caveats, "the uncommitted changes did not apply on the copy, so they exist only on the source")
	}
	if r.Files != nil && r.Files.Error != "" {
		caveats = append(caveats, "the ignored files did not all cross: "+r.Files.Error)
	}
	if r.Source != nil && !r.Source.Done {
		verb := sourceFateDone[r.Source.Fate]
		caveats = append(caveats, fmt.Sprintf("the source was not %s: %s", verb, r.Source.Error))
	}
	return caveats
}

type syncProgress struct {
	Step        string `json:"step"`
	CreatePhase string `json:"createPhase,omitempty"`
}

var transferStepLabels = map[string]string{
	"capture":  "capturing uncommitted changes",
	"transfer": "transferring commits",
	"create":   "creating the worktree",
	"apply":    "applying uncommitted changes",
	"files":    "copying ignored files",
}

// Progress as the app streams it: every frame as an NDJSON event in
// --json, one stderr line per step (and per create phase) otherwise,
// since a transfer frame arrives per chunk.
func transferProgress() func(string, json.RawMessage) {
	last := ""
	return func(channel string, payload json.RawMessage) {
		if channel != "sync:pullProgress" {
			return
		}
		if jsonMode {
			var doc map[string]any
			if json.Unmarshal(payload, &doc) == nil {
				doc["event"] = "progress"
				emit(doc)
			}
			return
		}
		var progress syncProgress
		if json.Unmarshal(payload, &progress) != nil {
			return
		}
		line := transferStepLabels[progress.Step]
		if line == "" {
			line = progress.Step
		}
		if progress.CreatePhase != "" && progress.CreatePhase != "idle" {
			line += " (" + progress.CreatePhase + ")"
		}
		if line == last {
			return
		}
		last = line
		note(dimErr("  " + line))
	}
}

func transferSpec() argSpec {
	spec := worktreeTargetSpec()
	spec.strings["to"] = nil
	spec.strings["from"] = nil
	spec.strings["leave-out"] = nil
	spec.strings["source"] = nil
	spec.bools["setup"] = nil
	spec.bools["no-setup"] = nil
	return spec
}

// A blank device is refused, not read as none: an unset shell variable
// in `--from "$DEVICE"` would otherwise read as no direction at all,
// and turn a bring into a send to whichever device qualifies.
func checkDeviceFlags(parsed parsedArgs) error {
	for _, flag := range []string{"to", "from"} {
		if value, given := parsed.strings[flag]; given && strings.TrimSpace(value) == "" {
			return usageErrf("--%s needs a device: its name, the start of its name, or its id (%s devices).", flag, binaryName)
		}
	}
	return nil
}

// The options every transfer takes, as the control op takes them.
// Nothing asked is nothing sent: the app then applies the project's
// saved leave-out rule and the setup default that goes with it.
func transferOptions(parsed parsedArgs, device string, mirror bool) (map[string]any, error) {
	input := map[string]any{}
	if device != "" {
		input["device"] = device
	}
	if mirror {
		input["mirror"] = true
	}
	if rule := parsed.strings["leave-out"]; rule != "" {
		if rule != "nothing" && rule != "gitignored" {
			return nil, usageErrf("--leave-out is nothing or gitignored.")
		}
		input["leaveOut"] = rule
	}
	if parsed.bools["setup"] && parsed.bools["no-setup"] {
		return nil, usageErrf("--setup and --no-setup can't both be given.")
	}
	if parsed.bools["setup"] {
		input["setup"] = true
	}
	if parsed.bools["no-setup"] {
		input["setup"] = false
	}
	if fate := parsed.strings["source"]; fate != "" {
		if mirror {
			return nil, usageErrf("--source is for send and bring. A mirror keeps its original.")
		}
		if fate != "keep" && fate != "shelve" && fate != "teardown" {
			return nil, usageErrf("--source is keep, shelve, or teardown.")
		}
		input["source"] = fate
	}
	return input, nil
}

// A --json answer is the app's own document, whole (the worktree or
// the mirror as the app describes it), not the slice of it this file
// reads, with the CLI's fields beside it.
func emitAppDoc(raw json.RawMessage, extra map[string]any) {
	doc := map[string]any{}
	_ = json.Unmarshal(raw, &doc)
	doc["ok"] = true
	for key, value := range extra {
		doc[key] = value
	}
	emit(doc)
}

// Reports a finished transfer and picks the exit code: 3 when it
// landed with a caveat, so a script (or an agent) can't read a
// half-kept promise as a clean run.
func reportTransfer(raw json.RawMessage, result controlTransferResult, headline string) (int, error) {
	caveats := result.caveats()
	code := 0
	if len(caveats) > 0 {
		code = 3
	}
	if jsonMode {
		emitAppDoc(raw, map[string]any{"caveats": caveats})
		return code, nil
	}
	// create's contract: the story on stderr, the copy's path alone on
	// stdout, so `cd "$(sm worktrees bring <name>)"` works. A copy on
	// the other device has no path here, so it is part of the story.
	note(greenErr(headline))
	if result.Captured && result.DirtyApplied {
		note(dimErr("  uncommitted changes went along"))
	}
	if result.Files != nil && result.Files.Crossed {
		note(dimErr("  ignored files went along"))
	}
	if result.Source != nil && result.Source.Done && result.Source.Fate != "keep" {
		note(dimErr("  source " + sourceFateDone[result.Source.Fate]))
	}
	for _, caveat := range caveats {
		note(yellowErr("! " + caveat))
	}
	if result.CopySide == "local" {
		out(result.Worktree.Path)
	} else {
		note(dimErr(fmt.Sprintf("  at %s on %q", result.Worktree.Path, result.Device.Name)))
	}
	return code, nil
}

func transferHeadline(result controlTransferResult, mirror bool, sent bool) string {
	name := result.Worktree.Name
	device := `"` + result.Device.Name + `"`
	switch {
	case result.Already:
		return fmt.Sprintf("%s is already mirrored with %s", name, device)
	case mirror && sent:
		return fmt.Sprintf("mirroring %s to %s", name, device)
	case mirror:
		return fmt.Sprintf("mirroring %s from %s", name, device)
	case sent:
		return fmt.Sprintf("sent %s to %s", name, device)
	default:
		return fmt.Sprintf("brought %s from %s", name, device)
	}
}

// One of this device's worktrees to another device: moved, or with
// mirror kept in step there. The primary checkout is on the menu for
// a mirror alone (its copy lands on mirror/<branch> there). A send
// would have to move the project itself.
func runSend(ctx cliContext, parsed parsedArgs, mirror bool) (int, error) {
	target, err := resolveWorktreeArgs(ctx, parsed, mirror)
	if err != nil {
		return exitCodeOf(err), err
	}
	input, err := transferOptions(parsed, parsed.strings["to"], mirror)
	if err != nil {
		return exitCodeOf(err), err
	}
	input["projectId"] = target.proj.ID
	input["worktreeId"] = target.worktree.ID
	var result controlTransferResult
	raw, err := controlInvoke("control:send", input, &result, transferProgress())
	if err != nil {
		return exitCodeOf(err), err
	}
	return reportTransfer(raw, result, transferHeadline(result, mirror, true))
}

// One of another device's worktrees to this one, the same two ways.
func runBring(ctx cliContext, parsed parsedArgs, mirror bool) (int, error) {
	proj, err := resolveProjectArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	wanted := parsed.positional(0)
	if wanted == "" {
		return 2, usageErrf("Which worktree? `%s worktrees list --remote` shows what your other devices hold.", binaryName)
	}
	input, err := transferOptions(parsed, parsed.strings["from"], mirror)
	if err != nil {
		return exitCodeOf(err), err
	}
	input["projectId"] = proj.ID
	input["worktree"] = wanted
	var result controlTransferResult
	raw, err := controlInvoke("control:bring", input, &result, transferProgress())
	if err != nil {
		return exitCodeOf(err), err
	}
	return reportTransfer(raw, result, transferHeadline(result, mirror, false))
}

func cmdSend(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, transferSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	if err := checkDeviceFlags(parsed); err != nil {
		return 2, err
	}
	if parsed.strings["from"] != "" {
		return 2, usageErrf("send goes --to a device. To move one here: %s worktrees bring <worktree> --from <device>.", binaryName)
	}
	return runSend(ctx, parsed, false)
}

func cmdBring(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, transferSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	if err := checkDeviceFlags(parsed); err != nil {
		return 2, err
	}
	if parsed.strings["to"] != "" {
		return 2, usageErrf("bring comes --from a device. To move one there: %s worktrees send [<name>] --to <device>.", binaryName)
	}
	return runBring(ctx, parsed, false)
}

// mirror is send or bring that stays: --to (or no direction) copies
// one of this device's worktrees to another device, --from copies one
// of theirs here, and either way the two follow each other until
// unmirror.
func cmdMirror(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, transferSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	if err := checkDeviceFlags(parsed); err != nil {
		return 2, err
	}
	if parsed.strings["to"] != "" && parsed.strings["from"] != "" {
		return 2, usageErrf("A mirror goes one way: --to a device, or --from one.")
	}
	if parsed.strings["from"] != "" {
		return runBring(ctx, parsed, true)
	}
	return runSend(ctx, parsed, true)
}

// worktrees list --remote [--from <device>]: the project's worktrees
// on the user's other devices, the names bring and mirror --from take.
func listRemoteWorktrees(proj project, device string) (int, error) {
	input := map[string]any{"projectId": proj.ID}
	if device != "" {
		input["device"] = device
	}
	var result struct {
		Worktrees []struct {
			Device   controlNamedDevice `json:"device"`
			Worktree json.RawMessage    `json:"worktree"`
		} `json:"worktrees"`
		Unreachable []string `json:"unreachable"`
	}
	if _, err := controlInvoke("control:peerWorktrees", input, &result, nil); err != nil {
		return exitCodeOf(err), err
	}
	// Said in both modes, on stderr: an empty list must not read as
	// "nothing there" when a device simply wasn't asked.
	for _, name := range result.Unreachable {
		note(yellowErr(fmt.Sprintf(`! "%s" is not connected, so its worktrees are not listed`, name)))
	}
	if jsonMode {
		// list's shape, an array of worktrees, each saying whose it is.
		flat := []map[string]any{}
		for _, entry := range result.Worktrees {
			doc := map[string]any{}
			_ = json.Unmarshal(entry.Worktree, &doc)
			doc["device"] = entry.Device
			flat = append(flat, doc)
		}
		emit(flat)
		return 0, nil
	}
	if len(result.Worktrees) == 0 {
		out(dimOut("No worktrees of " + proj.Name + " on another connected device."))
		return 0, nil
	}
	rows := make([][]string, 0, len(result.Worktrees))
	for _, entry := range result.Worktrees {
		var worktree controlWorktree
		_ = json.Unmarshal(entry.Worktree, &worktree)
		rows = append(rows, []string{worktree.Name, worktree.Branch, entry.Device.Name})
	}
	out(renderTable([]string{"WORKTREE", "BRANCH", "DEVICE"}, rows))
	return 0, nil
}

// The slice of the app's mirror document the tables read.
type controlMirror struct {
	Device    controlNamedDevice `json:"device"`
	LocalRoot string             `json:"localRoot"`
	CopySide  string             `json:"copySide"`
	Paused    bool               `json:"paused"`
	Status    string             `json:"status"`
	Git       string             `json:"git,omitempty"`
	Conflicts int                `json:"conflicts"`
}

// unmirror [<name>] [-f] stops the mirror the worktree is part of and
// removes the copy, whichever side that is. The original stays.
func cmdUnmirror(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.bools["force"] = []string{"f"}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	input := map[string]any{"projectId": target.proj.ID, "worktreeId": target.worktree.ID}
	if parsed.bools["force"] {
		input["force"] = true
	}
	var result struct {
		Mirror     controlMirror `json:"mirror"`
		CopyStayed string        `json:"copyStayed"`
	}
	raw, err := controlInvoke("control:mirrorStop", input, &result, nil)
	if err != nil {
		if errorKindOf(err) == "stop-unconfirmed" {
			return 1, codedErrf("stop-unconfirmed",
				"%s\nStopping removes the copy, so make sure both sides hold the work (%s worktrees mirrors), or pass -f to stop anyway.",
				err.Error(), binaryName)
		}
		return exitCodeOf(err), err
	}
	// The mirror stopped either way. A copy that stayed is the caveat
	// exit 3 is for, as on a transfer.
	caveats := []string{}
	code := 0
	if result.CopyStayed != "" {
		caveats = append(caveats, result.CopyStayed)
		code = 3
	}
	if jsonMode {
		emitAppDoc(raw, map[string]any{"caveats": caveats})
		return code, nil
	}
	out(greenOut("stopped mirroring " + target.worktree.Name))
	if code != 0 {
		note(yellowErr("! " + result.CopyStayed))
		return code, nil
	}
	if result.Mirror.CopySide == "local" {
		out(dimOut("  removed the copy here: " + result.Mirror.LocalRoot))
	} else {
		out(dimOut(fmt.Sprintf(`  removed the copy on "%s"`, result.Mirror.Device.Name)))
	}
	return 0, nil
}

// mirrors lists the mirrors this device runs.
func cmdMirrors(_ cliContext, args []string) (int, error) {
	if len(args) > 0 {
		return 2, usageErrf("mirrors takes no arguments.")
	}
	var result struct {
		Daemon  string          `json:"daemon"`
		Mirrors []controlMirror `json:"mirrors"`
	}
	raw, err := controlInvoke("control:mirrors", nil, &result, nil)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emitAppDoc(raw, nil)
		return 0, nil
	}
	if result.Daemon != "running" {
		note(yellowErr("! the mirror engine is " + result.Daemon))
	}
	if len(result.Mirrors) == 0 {
		out(dimOut("No mirrors running on this device."))
		return 0, nil
	}
	rows := make([][]string, 0, len(result.Mirrors))
	for _, mirror := range result.Mirrors {
		copyAt := "copy there"
		if mirror.CopySide == "local" {
			copyAt = "copy here"
		}
		state := mirror.Status
		if mirror.Paused {
			state = "paused"
		}
		if mirror.Conflicts > 0 {
			state += fmt.Sprintf(" (%d conflicts)", mirror.Conflicts)
		}
		git := mirror.Git
		if git == "" {
			git = "-"
		}
		rows = append(rows, []string{mirror.LocalRoot, mirror.Device.Name, copyAt, state, git})
	}
	out(renderTable([]string{"WORKTREE", "DEVICE", "COPY", "FILES", "GIT"}, rows))
	return 0, nil
}

type controlDevice struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Block    string `json:"block,omitempty"`
}

var deviceBlockLabels = map[string]string{
	"offline":    "not connected",
	"no-project": "no checkout of this repo",
	"no-grant":   "doesn't accept commands",
}

// devices lists the account's other devices. Inside a project (or
// with -p) each says whether it could take a send of it or serve a
// bring.
func cmdDevices(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}, "project-id": {}},
		bools:   map[string][]string{},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	input := map[string]any{}
	scoped := parsed.strings["project"] != "" || parsed.strings["project-id"] != "" || ctx.current != nil
	if scoped {
		proj, err := resolveProjectArgs(ctx, parsed)
		if err != nil {
			return exitCodeOf(err), err
		}
		input["projectId"] = proj.ID
	}
	var result struct {
		ThisDevice controlNamedDevice `json:"thisDevice"`
		Devices    []controlDevice    `json:"devices"`
	}
	raw, err := controlInvoke("control:devices", input, &result, nil)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emitAppDoc(raw, nil)
		return 0, nil
	}
	out(dimOut(`This device is "` + result.ThisDevice.Name + `".`))
	if len(result.Devices) == 0 {
		out(dimOut("The account has no other device."))
		return 0, nil
	}
	rows := make([][]string, 0, len(result.Devices))
	for _, device := range result.Devices {
		state := greenOut("ready")
		if !scoped {
			state = greenOut("connected")
		}
		if device.Block != "" {
			label, known := deviceBlockLabels[device.Block]
			if !known {
				// A reason from a newer app than this CLI.
				label = device.Block
			}
			state = yellowOut(label)
		}
		rows = append(rows, []string{device.Name, device.Platform, state})
	}
	out(renderTable([]string{"DEVICE", "PLATFORM", "STATUS"}, rows))
	return 0, nil
}
