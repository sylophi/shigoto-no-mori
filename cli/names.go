package main

// Names for worktree directories: adjective + animal pairs, or Animal
// Crossing character names with doubutsuNames on. The pools are
// embedded from embed/. The app picks no names itself: it asks
// `sm worktrees destination` for one, and `sm create` picks the same way.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math/rand/v2"
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

// Parsed on first use: only a create without a name needs it.
var doubutsuNames = sync.OnceValue(func() []string {
	var doc struct {
		Names []string `json:"names"`
	}
	if err := json.Unmarshal(doubutsuNamesJSON, &doc); err != nil {
		panic("embedded doubutsu-names.json is invalid: " + err.Error())
	}
	return doc.Names
})

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

func pickWorktreeName(used map[string]bool, doubutsu bool) string {
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
