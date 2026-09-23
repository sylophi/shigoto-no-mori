// Names for worktree directories. By default an adjective + animal
// pair, like `snuggly-otter` or `zippy-quokka`. With the device's
// `doubutsuNames` setting on, an Animal Crossing villager or character
// name, like `raymond` or `tom-nook`. The branch is what occupies the
// worktree; the name is the "container". Names are single lowercase
// kebab-case tokens so they're safe as filesystem path components.
//
// The pools live in cli/embed/, embedded into the Go CLI (which does
// the picking at create time) and imported here for the New Worktree
// form's pre-pick, so both draw from the same names.
import doubutsuNames from "../../../cli/embed/doubutsu-names.json";
import nameWords from "../../../cli/embed/name-words.json";

const ADJECTIVES: readonly string[] = nameWords.adjectives;
const ANIMALS: readonly string[] = nameWords.animals;
const DOUBUTSU: readonly string[] = doubutsuNames.names;

export function pickWorktreeName(
  used: ReadonlySet<string>,
  doubutsu: boolean,
): string {
  // Built per pick rather than held for the app's lifetime: the form's
  // pre-pick is rare, and enumerating the thousands of pairs lets us
  // pick uniformly across the unused set without retry loops.
  const pool = doubutsu
    ? DOUBUTSU
    : ADJECTIVES.flatMap((adj) => ANIMALS.map((animal) => `${adj}-${animal}`));
  const candidates = pool.filter((name) => !used.has(name));
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  // Every name is taken (vanishingly unlikely for pairs, a few hundred
  // live worktrees for doubutsu names): pick any base and walk numeric
  // suffixes until one's free.
  const base = pool[Math.floor(Math.random() * pool.length)];
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
