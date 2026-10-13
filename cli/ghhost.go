package main

// The GitHub host a repo's gh runs are pinned to (runGhContext), the
// app's getGithubRepoInfo (host/lib/githubCli/remote.ts): `gh api`
// asks github.com unless told otherwise, even in a repo on an
// Enterprise host, so a repo's merge settings and stacks would be read
// from the wrong server.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The host of the repo's first remote that gh is signed in to, or ""
// for none (no GitHub remote, not a repo, or no repo given).
func ghHostFor(projectPath string) string {
	if projectPath == "" {
		return ""
	}
	stdout, err := runGit(projectPath, "remote", "-v")
	if err != nil {
		return ""
	}
	known := ghKnownHosts()
	for _, line := range strings.Split(stdout, "\n") {
		m := remoteFetchLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if host, _, _ := strings.Cut(normalizeRemoteURL(m[2]), "/"); known[host] {
			return host
		}
	}
	return ""
}

var ghHostsLineRe = regexp.MustCompile(`^([^\s:#]+):\s*$`)

// The hosts gh is signed in to: the top-level keys of its hosts.yml,
// and github.com even without one.
func ghKnownHosts() map[string]bool {
	hosts := map[string]bool{"github.com": true}
	content, err := os.ReadFile(ghHostsPath())
	if err != nil {
		return hosts
	}
	for _, line := range strings.Split(string(content), "\n") {
		if m := ghHostsLineRe.FindStringSubmatch(line); m != nil {
			hosts[m[1]] = true
		}
	}
	return hosts
}

// gh's own precedence: GH_CONFIG_DIR, then the XDG config directory.
func ghHostsPath() string {
	if dir := os.Getenv("GH_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "hosts.yml")
	}
	return filepath.Join(configHomeDir(), "gh", "hosts.yml")
}
