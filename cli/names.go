package main

// Adjective + animal pairs for naming worktree directories. The word
// lists are embedded from embed/name-words.json, which the app's
// main/lib/worktrees/names.ts imports too -- one pool, two consumers,
// nothing to keep in sync by hand.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math/rand/v2"
)

//go:embed embed/name-words.json
var nameWordsJSON []byte

var nameWords struct {
	Adjectives []string `json:"adjectives"`
	Animals    []string `json:"animals"`
}

func init() {
	if err := json.Unmarshal(nameWordsJSON, &nameWords); err != nil {
		panic("embedded name-words.json is invalid: " + err.Error())
	}
}

func pickWorktreeName(used map[string]bool) string {
	adjectives, animals := nameWords.Adjectives, nameWords.Animals
	var candidates []string
	for _, adj := range adjectives {
		for _, animal := range animals {
			name := adj + "-" + animal
			if !used[name] {
				candidates = append(candidates, name)
			}
		}
	}
	if len(candidates) > 0 {
		return candidates[rand.IntN(len(candidates))]
	}
	base := adjectives[rand.IntN(len(adjectives))] + "-" + animals[rand.IntN(len(animals))]
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !used[candidate] {
			return candidate
		}
	}
}
