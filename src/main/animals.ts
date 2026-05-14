// Cute-animal pool for randomly naming worktree directories.
// The branch is what occupies the worktree; the animal is the "container".
// Names are single lowercase words so they're safe as filesystem path
// components.

const ANIMALS: readonly string[] = [
  "otter",
  "panda",
  "capybara",
  "fennec",
  "badger",
  "lynx",
  "ocelot",
  "beaver",
  "raccoon",
  "koala",
  "hedgehog",
  "marmot",
  "chinchilla",
  "ferret",
  "weasel",
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
  "wolf",
  "coyote",
  "dingo",
  "cheetah",
  "jaguar",
  "leopard",
  "cougar",
  "bobcat",
  "caracal",
  "serval",
  "marten",
  "ermine",
  "stoat",
  "mink",
  "tapir",
  "seal",
  "walrus",
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
  "urchin",
  "starfish",
  "puffin",
  "kiwi",
  "quail",
  "hummingbird",
  "kingfisher",
  "hoopoe",
  "parrot",
  "finch",
  "robin",
  "sparrow",
  "warbler",
  "wren",
  "magpie",
  "gecko",
  "iguana",
  "chameleon",
  "tortoise",
  "salamander",
  "newt",
  "mantis",
];

export function pickWorktreeName(used: ReadonlySet<string>): string {
  const available = ANIMALS.filter((a) => !used.has(a));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // Vanishingly unlikely (75+ worktrees in one project), but cover it.
  const base = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
