// Adjective + animal pairs for naming worktree directories, like
// `snuggly-otter` or `zippy-quokka`. The branch is what occupies the
// worktree; the name is the "container". Combinations are single
// lowercase kebab-case tokens so they're safe as filesystem path
// components.

const ADJECTIVES: readonly string[] = [
  "snuggly",
  "sleepy",
  "drowsy",
  "gentle",
  "fluffy",
  "plump",
  "mellow",
  "dreamy",
  "cozy",
  "soft",
  "tender",
  "hushed",
  "zippy",
  "perky",
  "peppy",
  "wiggly",
  "jazzy",
  "sparkly",
  "bouncy",
  "dapper",
  "jolly",
  "plucky",
  "sprightly",
  "dizzy",
  "breezy",
  "snappy",
  "spunky",
  "chirpy",
  "goofy",
  "scrappy",
  "tiny",
  "wee",
  "dainty",
  "polite",
  "kind",
  "brave",
  "swift",
  "sunny",
  "merry",
  "bright",
  "eager",
  "fond",
  "lucky",
  "jaunty",
  "nimble",
  "quiet",
  "cheery",
  "happy",
  "rosy",
  "dandy",
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
  "ferret",
  "mouse",
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
  "cheetah",
  "caracal",
  "marten",
  "ermine",
  "mink",
  "tapir",
  "seal",
  "narwhal",
  "beluga",
  "dolphin",
  "manatee",
  "dugong",
  "axolotl",
  "octopus",
  "cuttlefish",
  "nautilus",
  "seahorse",
  "pufferfish",
  "puffin",
  "kiwi",
  "quail",
  "hummingbird",
  "kingfisher",
  "hoopoe",
  "robin",
  "sparrow",
  "wren",
  "gecko",
  "chameleon",
  "salamander",
];

export function pickWorktreeName(used: ReadonlySet<string>): string {
  // 50 × 50 = 2500 pairs. Enumeration is microseconds and lets us pick
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
