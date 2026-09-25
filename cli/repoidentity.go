package main

// Repository identity: decides when the same project on two devices is
// the same repo. Root commit first, normalized remote URL second, none
// third, so a fork and its upstream (same root, different remotes)
// share an identity and a shallow clone (whose reported root is fake)
// still gets a remote-based one. Carried on `sm projects list --json`
// rows as `identity`. The algorithm is the one in the app's
// shared/git/repoIdentity.mts, which the app's peers also run, so the
// two must produce the same key for the same repo (repoidentity_test.go
// pins the normalization table). Derived, never persisted.

import (
	"regexp"
	"slices"
	"strings"
)

// "" when the repo has no identity or a git probe failed. The app's
// list treats both as null (never matches across devices).
func repoIdentity(projectPath string) string {
	if key, ok := rootCommitKey(projectPath); !ok {
		return ""
	} else if key != "" {
		return key
	}
	key, _ := remoteIdentityKey(projectPath)
	return key
}

// `root:<sha>` of the parentless commit reachable from the DEFAULT ref
// (never HEAD, or the key would identify the checkout instead of the
// repo). Shallow clones, an unresolvable default ref and a rootless
// answer fall through to the remote rule (""). A failed git run is
// ok=false, which the caller turns into "no identity" rather than
// falling through, the same as the app's rejection.
func rootCommitKey(projectPath string) (string, bool) {
	shallow, err := runGit(projectPath, "rev-parse", "--is-shallow-repository")
	if err != nil {
		return "", false
	}
	if strings.TrimSpace(shallow) != "false" {
		return "", true
	}
	scan, err := scanBranchRefs(projectPath)
	if err != nil {
		return "", false
	}
	ref := pickDefaultRef(scan, "", listRemotes(projectPath))
	if ref == "" {
		return "", true
	}
	stdout, err := runGit(projectPath, "rev-list", "--max-parents=0", ref, "--")
	if err != nil {
		return "", false
	}
	var roots []string
	for _, line := range strings.Split(stdout, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			roots = append(roots, trimmed)
		}
	}
	if len(roots) == 0 {
		return "", true
	}
	slices.Sort(roots)
	return "root:" + roots[0], true
}

var remoteFetchLineRe = regexp.MustCompile(`^(\S+)\s+(\S+)\s+\(fetch\)`)

// `remote:<host/owner/repo>` from the primary fetch remote (upstream,
// then origin, then the alphabetically first: orderRemotesByPrecedence),
// considering only remotes whose URL normalizes.
func remoteIdentityKey(projectPath string) (string, bool) {
	stdout, err := runGit(projectPath, "remote", "-v")
	if err != nil {
		return "", false
	}
	usable := map[string]string{}
	var names []string
	for _, line := range strings.Split(stdout, "\n") {
		m := remoteFetchLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if _, seen := usable[m[1]]; seen {
			continue
		}
		if normalized := normalizeRemoteURL(m[2]); normalized != "" {
			usable[m[1]] = normalized
			names = append(names, m[1])
		}
	}
	ordered := orderRemotesByPrecedence(names)
	if len(ordered) == 0 {
		return "", true
	}
	return "remote:" + usable[ordered[0]], true
}

var (
	urlSchemeRe   = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*)://`)
	driveLetterRe = regexp.MustCompile(`^[a-zA-Z]:`)
	localPathRe   = regexp.MustCompile(`^(\.\.?/|/|~)`)
)

// Reduces a remote URL to `host/owner/repo`: credentials and port
// stripped, the host's ASCII letters lowercased, a leading `ssh.`
// alias folded off, path case preserved, trailing `.git` and slashes
// dropped. "" for anything machine-local (plain paths, `~` paths,
// `file://`). Handles scheme URLs and scp-style with or without a
// user.
func normalizeRemoteURL(url string) string {
	raw := strings.TrimSpace(url)
	if raw == "" {
		return ""
	}
	if m := urlSchemeRe.FindStringSubmatch(raw); m != nil {
		if strings.EqualFold(m[1], "file") {
			return ""
		}
		rest := raw[len(m[0]):]
		authority, path, _ := strings.Cut(rest, "/")
		return joinHostPath(stripURLPort(stripURLUser(authority)), path)
	}
	// git's scp-vs-path heuristic: a colon before the first slash means
	// ssh, unless it looks like a drive letter or the URL is an
	// explicit path.
	if driveLetterRe.MatchString(raw) || localPathRe.MatchString(raw) {
		return ""
	}
	colon := strings.Index(raw, ":")
	if colon < 0 {
		return ""
	}
	if slash := strings.Index(raw, "/"); slash >= 0 && slash < colon {
		return ""
	}
	return joinHostPath(stripURLUser(raw[:colon]), raw[colon+1:])
}

func stripURLUser(authority string) string {
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		return authority[at+1:]
	}
	return authority
}

func stripURLPort(host string) string {
	if colon := strings.LastIndex(host, ":"); colon >= 0 {
		return host[:colon]
	}
	return host
}

func joinHostPath(host, path string) string {
	repo := strings.TrimRight(strings.TrimLeft(path, "/"), "/")
	if trimmed, ok := strings.CutSuffix(repo, ".git"); ok {
		repo = strings.TrimRight(trimmed, "/")
	}
	// ASCII-only lowering: hosts with other letters are already outside
	// any registrable name, and everything else stays byte for byte.
	folded := []byte(host)
	for i, c := range folded {
		if 'A' <= c && c <= 'Z' {
			folded[i] = c + ('a' - 'A')
		}
	}
	// `ssh.<host>` is the host's SSH-over-443 alias: same repo, one key.
	lowered := strings.TrimPrefix(string(folded), "ssh.")
	if lowered == "" || repo == "" {
		return ""
	}
	return lowered + "/" + repo
}
