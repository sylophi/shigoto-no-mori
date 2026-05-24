// Adjective + animal pairs for naming worktree directories, like
// `snuggly-otter` or `zippy-quokka`. The branch is what occupies the
// worktree; the name is the "container". Combinations are single
// lowercase kebab-case tokens so they're safe as filesystem path
// components.

const ADJECTIVES: readonly string[] = [
  "snuggly",
  "sleepy",
  "drowsy",
  "dreamy",
  "cozy",
  "snug",
  "mellow",
  "gentle",
  "quiet",
  "soft",
  "fluffy",
  "fuzzy",
  "puffy",
  "floofy",
  "pillowy",
  "squishy",
  "cuddly",
  "huggy",
  "tiny",
  "wee",
  "dainty",
  "chubby",
  "round",
  "noodly",
  "wobbly",
  "zippy",
  "perky",
  "peppy",
  "wiggly",
  "bouncy",
  "jazzy",
  "sparkly",
  "twinkly",
  "snappy",
  "spunky",
  "scrappy",
  "breezy",
  "jolly",
  "chirpy",
  "goofy",
  "giggly",
  "bubbly",
  "smiley",
  "cheery",
  "happy",
  "merry",
  "sunny",
  "bright",
  "rosy",
  "polite",
  "kind",
  "brave",
  "swift",
  "eager",
  "lucky",
  "nimble",
];

const ANIMALS: readonly string[] = [
  "otter",
  "panda",
  "capybara",
  "fennec",
  "koala",
  "hedgehog",
  "marmot",
  "chinchilla",
  "mouse",
  "dormouse",
  "hamster",
  "chipmunk",
  "ferret",
  "meerkat",
  "lemur",
  "sloth",
  "wombat",
  "quokka",
  "pangolin",
  "armadillo",
  "alpaca",
  "llama",
  "fox",
  "raccoon",
  "cheetah",
  "caracal",
  "marten",
  "ermine",
  "tapir",
  "platypus",
  "bunny",
  "puppy",
  "kitten",
  "piglet",
  "duckling",
  "seal",
  "narwhal",
  "beluga",
  "dolphin",
  "manatee",
  "dugong",
  "axolotl",
  "nautilus",
  "seahorse",
  "jellyfish",
  "puffin",
  "kiwi",
  "hummingbird",
  "robin",
  "sparrow",
  "wren",
  "owl",
  "tit",
  "gecko",
  "chameleon",
  "salamander",
  "tortoise",
  "snail",
  "bumblebee",
  "firefly",
];

export function pickWorktreeName(used: ReadonlySet<string>): string {
  // 56 × 60 = 3360 pairs. Enumeration is microseconds and lets us pick
  // uniformly across the unused set without retry loops.
  const candidates: string[] = [];
  for (const adj of ADJECTIVES) {
    for (const animal of ANIMALS) {
      const name = `${adj}-${animal}`;
      if (!used.has(name)) candidates.push(name);
    }
  }
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  // Vanishingly unlikely (2500+ live worktrees in one project), but cover
  // it: pick any base and walk numeric suffixes until one's free.
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const base = `${adj}-${animal}`;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
