package main

// sm link prints the deep link that opens a worktree's page in the app,
// <scheme>://open/projects/<id>/worktrees/<id> (app/main/electron/
// deepLink.ts handles it).

import "net/url"

func worktreeDeepLink(target located) string {
	return deepLinkOrigin + "/projects/" + url.PathEscape(target.proj.ID) +
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
