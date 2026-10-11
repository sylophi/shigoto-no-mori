package main

// The task runners `sm run` offers next to package.json: a justfile's
// recipes and a Makefile's targets. Both are read as text, not through
// `just --dump` or `make -p`, so listing spawns nothing and works with
// neither tool installed. A recipe or target is listed as "just build"
// or "make test", which keeps it apart from a package.json script of
// the same name everywhere a script is known by its name (the use log,
// the manual order, the launch row).

import (
	"os"
	"regexp"
	"strings"
)

// The file each runner reads in a directory, by its own lookup rules:
// just matches "justfile" and ".justfile" in any case, make tries
// GNUmakefile, makefile, then Makefile. "" when there is none.
func findJustfile(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && (strings.EqualFold(name, "justfile") || strings.EqualFold(name, ".justfile")) {
			return name
		}
	}
	return ""
}

func findMakefile(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	present := map[string]bool{}
	for _, entry := range entries {
		if !entry.IsDir() {
			present[entry.Name()] = true
		}
	}
	for _, name := range []string{"GNUmakefile", "makefile", "Makefile"} {
		if present[name] {
			return name
		}
	}
	return ""
}

var justRecipeHeader = regexp.MustCompile(`^@?([A-Za-z_][A-Za-z0-9_-]*)`)

// A justfile's public recipes in file order. A recipe header starts at
// column 0 with its name and has a ':' that isn't the start of ':='
// (an assignment, alias or setting). Recipes named with a leading '_'
// or marked [private] are left out, as `just --list` leaves them out.
// The command shown is the body, or the dependencies when it has none.
func parseJustfile(raw string) []packageScript {
	var scripts []packageScript
	seen := map[string]bool{}
	private := false
	lines := strings.Split(raw, "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		if strings.HasPrefix(line, "[") {
			private = private || strings.Contains(line, "private")
			continue
		}
		match := justRecipeHeader.FindStringSubmatch(line)
		colon := strings.IndexByte(line, ':')
		if match == nil || colon < 0 || strings.HasPrefix(line[colon:], ":=") {
			if strings.TrimSpace(line) != "" && !strings.HasPrefix(line, "#") {
				private = false
			}
			continue
		}
		name := match[1]
		hidden := private || strings.HasPrefix(name, "_")
		private = false

		var body []string
		for i+1 < len(lines) {
			next := strings.TrimRight(lines[i+1], "\r")
			if next != "" && next[0] != ' ' && next[0] != '\t' {
				break
			}
			i++
			if step := strings.TrimLeft(strings.TrimSpace(next), "@-"); step != "" {
				body = append(body, step)
			}
		}
		if hidden || seen[name] {
			continue
		}
		seen[name] = true
		scripts = append(scripts, packageScript{
			Name:    "just " + name,
			Command: stepsOr(body, line[colon+1:]),
			Label:   name,
			runner:  "just",
		})
	}
	return scripts
}

// A Makefile's named targets in file order. Pattern rules, special
// targets (.PHONY), and file targets (anything with a '.', '/' or a
// variable in it) are left out, which leaves the ones meant to be run
// by name. Variable assignments, target-specific ones included, and
// define blocks aren't rules. A target declared more than once keeps
// its first place and the first recipe it is given.
func parseMakefile(raw string) []packageScript {
	var scripts []packageScript
	index := map[string]int{}
	hasRecipe := map[string]bool{}
	lines := strings.Split(strings.ReplaceAll(raw, "\\\r\n", "\\\n"), "\n")
	// Continued lines read as one.
	var joined []string
	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		for strings.HasSuffix(line, "\\") && i+1 < len(lines) {
			i++
			line = strings.TrimRight(strings.TrimSuffix(line, "\\"), " \t") + " " + strings.TrimSpace(lines[i])
		}
		joined = append(joined, line)
	}

	inDefine := false
	for i := 0; i < len(joined); i++ {
		line := joined[i]
		trimmed := strings.TrimSpace(line)
		if inDefine {
			inDefine = trimmed != "endef"
			continue
		}
		if strings.HasPrefix(trimmed, "define ") || trimmed == "define" {
			inDefine = true
			continue
		}
		if line == "" || line[0] == '\t' || line[0] == ' ' || line[0] == '#' {
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon < 0 || strings.ContainsRune(line[:colon], '=') {
			continue
		}
		rest := strings.TrimPrefix(line[colon+1:], ":")
		if strings.HasPrefix(rest, "=") {
			continue
		}
		prereqs, inline, _ := strings.Cut(rest, ";")
		if strings.ContainsRune(prereqs, '=') {
			continue
		}

		var body []string
		if step := makeStep(inline); step != "" {
			body = append(body, step)
		}
		for i+1 < len(joined) {
			next := joined[i+1]
			if next != "" && next[0] != '\t' && !strings.HasPrefix(strings.TrimSpace(next), "#") {
				break
			}
			i++
			if strings.HasPrefix(next, "\t") {
				if step := makeStep(next); step != "" {
					body = append(body, step)
				}
			}
		}

		command := stepsOr(body, prereqs)
		for _, target := range strings.Fields(line[:colon]) {
			if strings.ContainsAny(target, ".%/$()") {
				continue
			}
			if at, seen := index[target]; seen {
				if len(body) > 0 && !hasRecipe[target] {
					scripts[at].Command = command
					hasRecipe[target] = true
				}
				continue
			}
			index[target] = len(scripts)
			hasRecipe[target] = len(body) > 0
			scripts = append(scripts, packageScript{
				Name:    "make " + target,
				Command: command,
				Label:   target,
				runner:  "make",
			})
		}
	}
	return scripts
}

// A recipe line as it reads to a person: the echo and error prefixes
// make strips are stripped here too, and a comment line is dropped.
func makeStep(line string) string {
	step := strings.TrimLeft(strings.TrimSpace(line), "@-+ \t")
	if strings.HasPrefix(step, "#") {
		return ""
	}
	return step
}

func stepsOr(steps []string, fallback string) string {
	if len(steps) > 0 {
		return strings.Join(steps, "; ")
	}
	return strings.TrimSpace(fallback)
}
