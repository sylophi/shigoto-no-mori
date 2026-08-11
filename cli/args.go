package main

// Tiny argument parser that allows flags and positionals to interleave
// (node's parseArgs behavior, which the TS CLI had) -- stdlib flag
// stops at the first positional, which would break
// `sm create my-name -b my-branch`.

import "strings"

type argSpec struct {
	// canonical name -> aliases (all forms accepted with - or --)
	strings map[string][]string
	bools   map[string][]string
}

type parsedArgs struct {
	strings     map[string]string
	bools       map[string]bool
	positionals []string
}

func parseCmdArgs(args []string, spec argSpec) (parsedArgs, error) {
	result := parsedArgs{strings: map[string]string{}, bools: map[string]bool{}}
	canonical := map[string]string{}
	takesValue := map[string]bool{}
	register := func(names map[string][]string, valued bool) {
		for name, aliases := range names {
			for _, alias := range append(aliases, name) {
				canonical[alias] = name
				takesValue[alias] = valued
			}
		}
	}
	register(spec.strings, true)
	register(spec.bools, false)

	for i := 0; i < len(args); i++ {
		arg := args[i]
		// `--` ends option parsing: the rest is positional, matching
		// the node parseArgs behavior this parser mirrors. Lets a
		// command take passthrough args (`sm run dev -- --port 3000`)
		// or a positional that looks like a flag.
		if arg == "--" {
			result.positionals = append(result.positionals, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			result.positionals = append(result.positionals, arg)
			continue
		}
		name := strings.TrimLeft(arg, "-")
		value := ""
		hasInline := false
		if eq := strings.Index(name, "="); eq >= 0 {
			name, value = name[:eq], name[eq+1:]
			hasInline = true
		}
		canon, known := canonical[name]
		if !known {
			return result, usageErrf("Unknown option %q.", arg)
		}
		if takesValue[name] {
			if !hasInline {
				i++
				if i >= len(args) {
					return result, usageErrf("Option %q requires a value.", arg)
				}
				value = args[i]
			}
			result.strings[canon] = value
		} else {
			if hasInline {
				return result, usageErrf("Option %q takes no value.", arg)
			}
			result.bools[canon] = true
		}
	}
	return result, nil
}

// The arg-spec fragment shared by every command that targets a
// worktree: -p/--project scoping plus the app-plumbing ids
// (--project-id / --worktree-id) the IPC layer addresses by. Callers
// extend the returned maps with their own flags.
func worktreeTargetSpec() argSpec {
	return argSpec{
		strings: map[string][]string{
			"project":     {"p"},
			"project-id":  {},
			"worktree-id": {},
		},
		bools: map[string][]string{},
	}
}

func exitCodeOf(err error) int {
	if cliErr, ok := err.(*cliError); ok {
		return cliErr.code
	}
	return 1
}
