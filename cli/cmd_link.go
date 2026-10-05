package main

// sm link prints the deep link that opens a worktree's page in the app,
// <scheme>://open/devices/<id>/projects/<id>/worktrees/<id>
// (app/main/electron/deepLink.ts handles it). The device is this data
// dir's, so a link printed on another machine (over ssh, by an agent
// working there) opens that machine's worktree wherever it's clicked.

import "net/url"

// The id the app mints for this data dir on its first run.
func localDeviceID() (string, error) {
	var id string
	if err := decodeKey(registryPath(), deviceIDKey, readRegistryHints()[deviceIDKey], &id); err != nil {
		return "", err
	}
	if id == "" {
		return "", errf("This machine has no device id yet. Open the app here once, then retry.")
	}
	return id, nil
}

func cmdLink(ctx cliContext, args []string) (int, error) {
	_, target, err := parseWorktreeArgs(ctx, args, worktreeTargetSpec(), true)
	if err != nil {
		return exitCodeOf(err), err
	}
	deviceID, err := localDeviceID()
	if err != nil {
		return exitCodeOf(err), err
	}
	link := deepLinkOrigin + "/devices/" + url.PathEscape(deviceID) +
		"/projects/" + url.PathEscape(target.proj.ID) +
		"/worktrees/" + url.PathEscape(target.worktree.ID)
	emitOrOut(map[string]any{
		"ok":       true,
		"url":      link,
		"worktree": target.worktree.Name,
	}, link)
	return 0, nil
}
