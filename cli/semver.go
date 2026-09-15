package main

// Just enough semver 2.0.0 for the updater: parsing, precedence, and
// the "channel" a prerelease belongs to. The update server does this
// comparison for full releases (updater.go queryUpdateServer), but it
// hides prereleases entirely, so a prerelease build has to rank the
// release list itself.

import (
	"cmp"
	"fmt"
	"strconv"
	"strings"
)

type semver struct {
	major, minor, patch int
	// Prerelease identifiers ("beta", "2"), nil for a full release.
	// Build metadata is dropped at parse time: it never takes part in
	// precedence.
	pre []string
}

func (v semver) isPrerelease() bool { return len(v.pre) > 0 }

func (v semver) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.major, v.minor, v.patch)
	if v.isPrerelease() {
		s += "-" + strings.Join(v.pre, ".")
	}
	return s
}

// Accepts an optional leading "v" (release tags carry one, the
// injected build version doesn't).
func parseSemver(raw string) (semver, bool) {
	raw = strings.TrimPrefix(raw, "v")
	if i := strings.IndexByte(raw, '+'); i >= 0 {
		raw = raw[:i]
	}
	core, pre, hasPre := strings.Cut(raw, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semver{}, false
	}
	var nums [3]int
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		// Rejects signs and leading zeros, which Atoi would accept.
		if err != nil || strconv.Itoa(n) != part {
			return semver{}, false
		}
		nums[i] = n
	}
	v := semver{major: nums[0], minor: nums[1], patch: nums[2]}
	if hasPre {
		v.pre = strings.Split(pre, ".")
		for _, id := range v.pre {
			// A numeric identifier with a leading zero is invalid, and
			// would also sort wrong ("05" above "9").
			if !validIdentifier(id) || (isNumericIdentifier(id) && len(id) > 1 && id[0] == '0') {
				return semver{}, false
			}
		}
	}
	return v, true
}

func validIdentifier(id string) bool {
	return id != "" && strings.IndexFunc(id, func(r rune) bool {
		return !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-')
	}) < 0
}

func isNumericIdentifier(id string) bool {
	return id != "" && strings.IndexFunc(id, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

// Semver precedence: -1, 0, or 1 as a is lower than, equal to, or
// higher than b.
func compareSemver(a, b semver) int {
	if c := cmp.Compare(a.major, b.major); c != 0 {
		return c
	}
	if c := cmp.Compare(a.minor, b.minor); c != 0 {
		return c
	}
	if c := cmp.Compare(a.patch, b.patch); c != 0 {
		return c
	}
	// A prerelease ranks below the full release it precedes.
	if a.isPrerelease() != b.isPrerelease() {
		if a.isPrerelease() {
			return -1
		}
		return 1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		if c := compareIdentifier(a.pre[i], b.pre[i]); c != 0 {
			return c
		}
	}
	return cmp.Compare(len(a.pre), len(b.pre))
}

// Numeric identifiers compare numerically and rank below alphanumeric
// ones. Alphanumeric identifiers compare as ASCII.
func compareIdentifier(a, b string) int {
	aNum, bNum := isNumericIdentifier(a), isNumericIdentifier(b)
	switch {
	case aNum && bNum:
		if c := cmp.Compare(len(a), len(b)); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	case aNum:
		return -1
	case bNum:
		return 1
	}
	return strings.Compare(a, b)
}

// The release line a prerelease belongs to: its core version plus its
// prerelease identifiers minus a trailing counter, so 2.0.0-beta.1 and
// 2.0.0-beta.7 share "2.0.0-beta" while 2.0.0-test.keychain.1 and
// 2.1.0-beta.1 are each something else. "" for a full release.
func releaseChannel(v semver) string {
	if !v.isPrerelease() {
		return ""
	}
	ids := v.pre
	if len(ids) > 1 && isNumericIdentifier(ids[len(ids)-1]) {
		ids = ids[:len(ids)-1]
	}
	return semver{major: v.major, minor: v.minor, patch: v.patch, pre: ids}.String()
}
