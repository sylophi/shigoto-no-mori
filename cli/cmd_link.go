package main

// sm link prints the deep link that opens a worktree's page in the app,
// <scheme>://open/devices/<id>/projects/<id>/worktrees/<id>
// (app/main/electron/deepLink.ts handles it). The device is this data
// dir's, so a link printed on another machine (over ssh, by an agent
// working there) opens that machine's worktree and not a same-id
// lookup on the device it's clicked on.

import (
	"net/url"
	"regexp"
)

// The app's own check (host/lib/config/deviceId.ts): registry.json is
// hand-editable, and an id it would replace names no device.
var deviceIDRe = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// The id the app minted for this data dir, or "" when it hasn't run
// here yet. Then the link names no device and opens on whichever one
// it's clicked on, which is where it was printed if that's the only
// place the app runs.
func localDeviceID() string {
	var id string
	if decodeKey(registryPath(), deviceIDKey, readRegistryHints()[deviceIDKey], &id) != nil ||
		!deviceIDRe.MatchString(id) {
		return ""
	}
	return id
}

func worktreeDeepLink(target located) string {
	link := deepLinkOrigin
	if id := localDeviceID(); id != "" {
		link += "/devices/" + url.PathEscape(id)
	}
	return link + "/projects/" + url.PathEscape(target.proj.ID) +
		"/worktrees/" + url.PathEscape(target.worktree.ID)
}

func cmdLink(ctx cliContext, args []string) (int, error) {
	_, target, err := parseWorktreeArgs(ctx, args, worktreeTargetSpec(), true)
	if err != nil {
		return exitCodeOf(err), err
	}
	link := worktreeDeepLink(target)
	emitOrOut(map[string]any{
		"ok":       true,
		"url":      link,
		"worktree": target.worktree.Name,
	}, link)
	return 0, nil
}
