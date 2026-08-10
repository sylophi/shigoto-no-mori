package main

// Project icon resolution, ported from main/lib/projects/icon.ts so
// the CLI can color projects by logo without the app having run.
// Cache-first: the app persists every icon it resolves in
// iconCache/index.json under the state root, and an existing entry
// whose file is still on disk wins (keeping both surfaces on the same
// icon, including the app's monorepo descent). On a miss the same
// git-driven candidate scan runs here: every package root (repo top
// level plus each package.json directory, shallowest first) is probed
// for the conventional icon files, then for a <link rel="icon"> href
// in the usual source files. The candidate lists must stay in sync
// with icon.ts. Read-only: the CLI never writes the app's cache (it
// has no lock), so a miss re-scans -- listing git's view of a repo is
// cheap enough for a picker.

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var iconCandidates = []string{
	// Root -- the universal favicon convention.
	"favicon.svg",
	"favicon.ico",
	"favicon.png",

	// public/ -- Vite, CRA, Next.js, Nuxt.
	"public/favicon.svg",
	"public/favicon.ico",
	"public/favicon.png",

	// static/ -- Docusaurus, SvelteKit, Hugo, Jekyll.
	"static/favicon.svg",
	"static/favicon.ico",
	"static/favicon.png",
	"static/img/logo.svg",
	"static/img/logo.png",
	"static/img/favicon.svg",
	"static/img/favicon.ico",

	// app/ -- Next.js App Router (root layout).
	"app/icon.svg",
	"app/icon.png",
	"app/icon.ico",
	"app/favicon.ico",
	"app/favicon.png",

	// src/ -- Vite/CRA/Next.js with src layout, plus Astro's src/assets.
	"src/favicon.svg",
	"src/favicon.ico",
	"src/assets/logo.svg",
	"src/assets/logo.png",
	"src/assets/icon.svg",
	"src/assets/icon.png",
	"src/app/icon.svg",
	"src/app/icon.png",
	"src/app/favicon.ico",

	// assets/ -- Electron Forge, Expo, generic.
	"assets/icon.svg",
	"assets/icon.png",
	"assets/adaptive-icon.png",
	"assets/logo.svg",
	"assets/logo.png",

	// Docs-site conventions.
	"docs/.vitepress/public/logo.svg",
	"docs/.vitepress/public/favicon.svg",
	"docs/.vitepress/public/favicon.ico",

	// Mintlify.
	"logo/light.svg",
	"logo/dark.svg",
	"logo/light.png",
	"logo/dark.png",

	// Tauri.
	"src-tauri/icons/icon.svg",
	"src-tauri/icons/icon.png",
	"src-tauri/icons/icon.ico",

	// JetBrains project marker.
	".idea/icon.svg",
}

var iconSourceFiles = []string{
	"index.html",
	"public/index.html",
	"app/routes/__root.tsx",
	"src/routes/__root.tsx",
	"app/root.tsx",
	"src/root.tsx",
	"src/index.html",
}

// icon.ts matches these with lookaheads; RE2 has none, so scan the
// enclosing chunk (a <link> tag, or an object literal up to its `}`)
// and test rel/href separately.
var (
	linkTagRe  = regexp.MustCompile(`(?i)<link\b[^>]*>`)
	relHTMLRe  = regexp.MustCompile(`(?i)\brel=["'](?:icon|shortcut icon)["']`)
	hrefHTMLRe = regexp.MustCompile(`(?i)\bhref=["']([^"'?]+)`)
	relObjRe   = regexp.MustCompile(`(?i)\brel\s*:\s*["'](?:icon|shortcut icon)["']`)
	hrefObjRe  = regexp.MustCompile(`(?i)\bhref\s*:\s*["']([^"'?]+)`)
)

func extractIconHref(source string) string {
	for _, tag := range linkTagRe.FindAllString(source, -1) {
		if relHTMLRe.MatchString(tag) {
			if m := hrefHTMLRe.FindStringSubmatch(tag); m != nil {
				return m[1]
			}
		}
	}
	for _, chunk := range strings.Split(source, "}") {
		if relObjRe.MatchString(chunk) {
			if m := hrefObjRe.FindStringSubmatch(chunk); m != nil {
				return m[1]
			}
		}
	}
	return ""
}

func fileExists(abs string) bool {
	info, err := os.Stat(abs)
	return err == nil && info.Mode().IsRegular()
}

// Files git can see: tracked plus untracked-but-not-ignored, so build
// output and node_modules stay invisible while an uncommitted favicon
// still resolves. nil on any git failure -> filesystem fallback.
func listProjectFiles(cwd string) []string {
	stdout, err := runGit(cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil
	}
	var files []string
	for _, f := range strings.Split(stdout, "\x00") {
		if f != "" {
			files = append(files, f)
		}
	}
	return files
}

// Repo root ("") plus every directory holding a package.json,
// shallowest first so the root and top-level packages win ties.
func packageRoots(files []string) []string {
	rootSet := map[string]bool{"": true}
	for _, file := range files {
		if file == "package.json" || strings.HasSuffix(file, "/package.json") {
			rootSet[path.Dir(file)] = true
		}
	}
	delete(rootSet, ".")
	roots := make([]string, 0, len(rootSet))
	for root := range rootSet {
		roots = append(roots, root)
	}
	// Depth then lex; "" naturally sorts first (depth 0, lex minimum).
	sort.Slice(roots, func(i, j int) bool {
		di, dj := strings.Count(roots[i], "/"), strings.Count(roots[j], "/")
		if di != dj {
			return di < dj
		}
		return roots[i] < roots[j]
	})
	return roots
}

// Where a <link rel="icon"> href lands within git's file set (path
// normalisation rejects traversal for free: an escaping href never
// matches a listed path), or on the raw filesystem when git listed
// nothing -- there the within-project guard does the rejecting.
func resolveHrefOnDisk(cwd, root, href string, files map[string]bool) string {
	clean := strings.TrimPrefix(href, "/")
	if files == nil {
		for _, rel := range []string{path.Join("public", clean), clean} {
			abs := filepath.Join(cwd, filepath.FromSlash(rel))
			if relPath, err := filepath.Rel(cwd, abs); err != nil ||
				relPath == ".." || strings.HasPrefix(relPath, ".."+string(os.PathSeparator)) {
				continue
			}
			if fileExists(abs) {
				return abs
			}
		}
		return ""
	}
	for _, candidate := range []string{
		path.Join(root, "public", clean),
		path.Join(root, clean),
	} {
		if files[candidate] {
			abs := filepath.Join(cwd, filepath.FromSlash(candidate))
			if fileExists(abs) {
				return abs
			}
		}
	}
	return ""
}

// The two-phase scan (conventional files, then <link rel="icon"> in a
// source file) scoped to one package root. Each git-listed match is
// confirmed on disk before winning -- a staged-then-deleted phantom
// can't shadow a lower-priority icon that exists.
func scanRootForIcon(cwd, root string, files map[string]bool) string {
	for _, candidate := range iconCandidates {
		rel := path.Join(root, candidate)
		if files != nil && !files[rel] {
			continue
		}
		abs := filepath.Join(cwd, filepath.FromSlash(rel))
		if fileExists(abs) {
			return abs
		}
	}
	for _, sourceFile := range iconSourceFiles {
		rel := path.Join(root, sourceFile)
		if files != nil && !files[rel] {
			continue
		}
		source, err := os.ReadFile(filepath.Join(cwd, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		href := extractIconHref(string(source))
		if href == "" {
			continue
		}
		if abs := resolveHrefOnDisk(cwd, root, href, files); abs != "" {
			return abs
		}
	}
	return ""
}

// --- The app's persisted cache ---

var appIconCache = sync.OnceValue(func() map[string]string {
	raw, err := os.ReadFile(filepath.Join(shigomoriRoot(), "iconCache", "index.json"))
	if err != nil {
		return nil
	}
	var index map[string]struct {
		SourcePath string `json:"sourcePath"`
	}
	if json.Unmarshal(raw, &index) != nil {
		return nil
	}
	// Keyed by comparablePath so the CLI's stored project path matches
	// however the app spelled the same directory.
	byPath := make(map[string]string, len(index))
	for projectPath, entry := range index {
		byPath[comparablePath(projectPath)] = entry.SourcePath
	}
	return byPath
})

// Absolute path of the project's icon, or "" when it has none.
func resolveProjectIcon(projectPath string) string {
	if cached := appIconCache()[comparablePath(projectPath)]; cached != "" && fileExists(cached) {
		return cached
	}
	files := listProjectFiles(projectPath)
	if len(files) == 0 {
		return scanRootForIcon(projectPath, "", nil)
	}
	fileSet := make(map[string]bool, len(files))
	for _, f := range files {
		fileSet[f] = true
	}
	for _, root := range packageRoots(files) {
		if abs := scanRootForIcon(projectPath, root, fileSet); abs != "" {
			return abs
		}
	}
	return ""
}
