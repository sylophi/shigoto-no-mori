package main

// Repo identity, ported from shared/repoIdentity.mts: decides when the
// same project on two devices is the same repo. Root commit first,
// normalized remote URL second, "" (no identity) third. That way a fork
// and its upstream share an identity, and a shallow clone (fake root)
// still gets a remote-based one. "" with a nil error is a legitimate
// outcome (machine-local repo, never merges) that callers MAY cache. A
// git-execution failure returns an error instead, so a transient
// failure can never be cached as "no identity". Never persisted.

import (
	"regexp"
	"sort"
	"strings"
)

func computeRepoIdentity(projectPath string) (string, error) {
	key, err := rootCommitKey(projectPath)
	if err != nil || key != "" {
		return key, err
	}
	return remoteIdentityKey(projectPath)
}

// "root:<sha>" of the first-parentless commit reachable from the
// DEFAULT ref (never HEAD, or the key would identify the checkout
// instead of the repo). Three guards, each falling through to the
// remote rule: shallow clones report a fake root, grafted history can
// have several roots (take the lexically first for determinism), and
// the default ref can be unresolvable (no candidate branches, no
// commits). Git failures are NOT guards: they propagate.
func rootCommitKey(projectPath string) (string, error) {
	shallow, err := runGit(projectPath, "rev-parse", "--is-shallow-repository")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(shallow) != "false" {
		return "", nil
	}
	// Fully qualified so a tag sharing the branch's name can't hijack
	// the rev-list below.
	ref, err := resolveDefaultRef(projectPath, "")
	if err != nil {
		return "", err
	}
	if ref == "" {
		return "", nil
	}
	stdout, err := runGit(projectPath, "rev-list", "--max-parents=0", ref, "--")
	if err != nil {
		return "", err
	}
	var roots []string
	for _, line := range strings.Split(stdout, "\n") {
		if sha := strings.TrimSpace(line); sha != "" {
			roots = append(roots, sha)
		}
	}
	if len(roots) == 0 {
		return "", nil
	}
	sort.Strings(roots)
	return "root:" + roots[0], nil
}

var remoteFetchRow = regexp.MustCompile(`^(\S+)\s+(\S+)\s+\(fetch\)`)

// "remote:<host/owner/repo>" from the primary fetch remote: "upstream"
// beats "origin" beats the alphabetically-first remote, considering only
// remotes whose URL normalizes (path-style and file:// remotes are
// machine-local, never identity keys).
func remoteIdentityKey(projectPath string) (string, error) {
	stdout, err := runGit(projectPath, "remote", "-v")
	if err != nil {
		return "", err
	}
	usable := map[string]string{}
	for _, line := range strings.Split(stdout, "\n") {
		match := remoteFetchRow.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		name, url := match[1], match[2]
		if _, seen := usable[name]; seen {
			continue
		}
		if normalized := normalizeRemoteURL(url); normalized != "" {
			usable[name] = normalized
		}
	}
	for _, name := range []string{"upstream", "origin"} {
		if hit := usable[name]; hit != "" {
			return "remote:" + hit, nil
		}
	}
	var names []string
	for name := range usable {
		names = append(names, name)
	}
	if len(names) == 0 {
		return "", nil
	}
	sort.Strings(names)
	return "remote:" + usable[names[0]], nil
}

var urlScheme = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*)://`)
var dosDrive = regexp.MustCompile(`^[a-zA-Z]:`)
var explicitPath = regexp.MustCompile(`^(\.\.?/|/|~)`)

// Reduces a remote URL to "host/owner/repo": credentials and port
// stripped, ASCII letters of the host lowercased, a leading "ssh."
// alias folded off the host, path case preserved, trailing ".git" and
// slashes dropped. Returns "" for anything machine-local (plain paths,
// "~" paths, file://). Handles all four git syntaxes: scheme URLs,
// scp-style with user, and scp-style WITHOUT a user prefix
// ("github.com:owner/repo" is valid git syntax).
func normalizeRemoteURL(url string) string {
	raw := strings.TrimSpace(url)
	if raw == "" {
		return ""
	}
	if scheme := urlScheme.FindStringSubmatch(raw); scheme != nil {
		if strings.EqualFold(scheme[1], "file") {
			return ""
		}
		rest := raw[len(scheme[0]):]
		authority, path, _ := strings.Cut(rest, "/")
		return joinHostPath(stripPort(stripUser(authority)), path)
	}
	// git's scp-vs-path heuristic: a colon before the first slash means
	// ssh, unless it looks like a Windows drive letter or the URL is an
	// explicit path ("./", "../", "/", "~").
	if dosDrive.MatchString(raw) || explicitPath.MatchString(raw) {
		return ""
	}
	colon := strings.Index(raw, ":")
	if colon == -1 {
		return ""
	}
	if slash := strings.Index(raw, "/"); slash != -1 && slash < colon {
		return ""
	}
	return joinHostPath(stripUser(raw[:colon]), raw[colon+1:])
}

func stripUser(authority string) string {
	if at := strings.LastIndex(authority, "@"); at != -1 {
		return authority[at+1:]
	}
	return authority
}

func stripPort(host string) string {
	if colon := strings.LastIndex(host, ":"); colon != -1 {
		return host[:colon]
	}
	return host
}

// ASCII-only: strings.ToLower and JS toLowerCase disagree on some
// Unicode mappings (U+0130 diverges), and hosts with such letters are
// already outside any registrable name. Lower only A-Z so both heads
// preserve everything else byte-for-byte.
func lowerASCIIHost(host string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, host)
}

func joinHostPath(host, path string) string {
	repo := strings.Trim(path, "/")
	if strings.HasSuffix(repo, ".git") {
		repo = strings.TrimRight(repo[:len(repo)-4], "/")
	}
	folded := lowerASCIIHost(host)
	// "ssh.<host>" is the host's SSH-over-443 alias (github.com
	// publishes ssh.github.com, and GHE mirrors the shape): same repo,
	// one key. Mirrors normalizeHost in host/lib/githubCli/remote.ts.
	folded = strings.TrimPrefix(folded, "ssh.")
	if folded == "" || repo == "" {
		return ""
	}
	return folded + "/" + repo
}
