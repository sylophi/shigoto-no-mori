// Adjective + animal pairs for naming worktree directories, like
// `snuggly-otter` or `zippy-quokka`. The branch is what occupies the
// worktree; the name is the "container". Combinations are single
// lowercase kebab-case tokens so they're safe as filesystem path
// components.
//
// The word lists live in cli/embed/name-words.json, embedded into the
// Go CLI and imported here, so both engines draw from one pool.
import nameWords from "../../../cli/embed/name-words.json";

const ADJECTIVES: readonly string[] = nameWords.adjectives;
const ANIMALS: readonly string[] = nameWords.animals;

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
