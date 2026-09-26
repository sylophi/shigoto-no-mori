package main

// Names for worktree directories: adjective + animal pairs, or Animal
// Crossing character names with doubutsuNames on (seeded on for fresh
// installs, see seedFreshInstall). The pools are embedded from embed/.
// The app picks no names itself: it asks `sm worktrees destination`
// for one, and `sm create` picks the same way. The doubutsu pool holds
// only the characters with a face on Nookipedia
// (app/shared/villagers/manifest.json), each with its birthday when
// the wiki gives one (birthdays.go).

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"maps"
	"math/rand/v2"
	"slices"
	"sync"
)

//go:embed embed/name-words.json
var nameWordsJSON []byte

//go:embed embed/doubutsu-names.json
var doubutsuNamesJSON []byte

var nameWords struct {
	Adjectives []string `json:"adjectives"`
	Animals    []string `json:"animals"`
}

func init() {
	if err := json.Unmarshal(nameWordsJSON, &nameWords); err != nil {
		panic("embedded name-words.json is invalid: " + err.Error())
	}
}

// The embedded doubutsu pool, keyed by slug. A character the wiki
// gives no birthday has none ("").
type doubutsuName struct {
	Birthday string `json:"birthday"`
}

// Parsed on first use: only a create without a name needs it.
var doubutsuPool = sync.OnceValue(func() map[string]doubutsuName {
	var doc struct {
		Names map[string]doubutsuName `json:"names"`
	}
	if err := json.Unmarshal(doubutsuNamesJSON, &doc); err != nil {
		panic("embedded doubutsu-names.json is invalid: " + err.Error())
	}
	return doc.Names
})

// The pool's names, sorted, so the order never depends on map
// iteration.
var doubutsuNames = sync.OnceValue(func() []string {
	return slices.Sorted(maps.Keys(doubutsuPool()))
})

// Off unless set: an install from before fresh installs were seeded
// with it on keeps the names it had. Matches doubutsuNamesEnabled in
// the app's shared/villageLife.ts.
func doubutsuNamesEnabled(global globalConfig) bool {
	return global.DoubutsuNames != nil && *global.DoubutsuNames
}

func namePool(doubutsu bool) []string {
	if doubutsu {
		return doubutsuNames()
	}
	pairs := make([]string, 0, len(nameWords.Adjectives)*len(nameWords.Animals))
	for _, adj := range nameWords.Adjectives {
		for _, animal := range nameWords.Animals {
			pairs = append(pairs, adj+"-"+animal)
		}
	}
	return pairs
}

// `invited` are the names to pick first while one is free: the
// villagers whose birthday it is (birthdayGuests).
func pickWorktreeName(used map[string]bool, doubutsu bool, invited []string) string {
	if doubutsu {
		// Only a name the pool has, so a guest is as safe a folder and
		// branch name as any pick.
		var guests []string
		for _, name := range invited {
			if _, inPool := doubutsuPool()[name]; inPool && !used[name] {
				guests = append(guests, name)
			}
		}
		if len(guests) > 0 {
			return guests[rand.IntN(len(guests))]
		}
	}
	pool := namePool(doubutsu)
	var candidates []string
	for _, name := range pool {
		if !used[name] {
			candidates = append(candidates, name)
		}
	}
	if len(candidates) > 0 {
		return candidates[rand.IntN(len(candidates))]
	}
	base := pool[rand.IntN(len(pool))]
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !used[candidate] {
			return candidate
		}
	}
}
