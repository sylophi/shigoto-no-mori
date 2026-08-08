package main

// Adjective + animal pairs for naming worktree directories. Must stay
// in sync with main/lib/worktrees/names.ts (the app-side authority) so
// both surfaces draw from the same pool.

import (
	"fmt"
	"math/rand/v2"
)

var adjectives = []string{
	"snuggly", "sleepy", "drowsy", "dreamy", "cozy", "snug", "mellow",
	"gentle", "quiet", "soft", "fluffy", "fuzzy", "puffy", "floofy",
	"pillowy", "squishy", "cuddly", "huggy", "tiny", "wee", "dainty",
	"chubby", "round", "noodly", "wobbly", "zippy", "perky", "peppy",
	"wiggly", "bouncy", "jazzy", "sparkly", "twinkly", "snappy", "spunky",
	"scrappy", "breezy", "jolly", "chirpy", "goofy", "giggly", "bubbly",
	"smiley", "cheery", "happy", "merry", "sunny", "bright", "rosy",
	"polite", "kind", "brave", "swift", "eager", "lucky", "nimble",
}

var animals = []string{
	"otter", "panda", "capybara", "fennec", "koala", "hedgehog", "marmot",
	"chinchilla", "mouse", "dormouse", "hamster", "chipmunk", "ferret",
	"meerkat", "lemur", "sloth", "wombat", "quokka", "pangolin",
	"armadillo", "alpaca", "llama", "fox", "raccoon", "cheetah", "caracal",
	"marten", "ermine", "tapir", "platypus", "bunny", "puppy", "kitten",
	"piglet", "duckling", "seal", "narwhal", "beluga", "dolphin",
	"manatee", "dugong", "axolotl", "nautilus", "seahorse", "jellyfish",
	"puffin", "kiwi", "hummingbird", "robin", "sparrow", "wren", "owl",
	"tit", "gecko", "chameleon", "salamander", "tortoise", "snail",
	"bumblebee", "firefly",
}

func pickWorktreeName(used map[string]bool) string {
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
