// Names for worktree directories: adjective-animal pairs, or Animal
// Crossing characters with a face on Nookipedia when the device's
// doubutsuNames setting is on. A name in `used` is never picked. When
// the pool runs out, a random name gets the first free -2, -3, ...
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import doubutsu from "./data/doubutsu-names.json" with { type: "json" };
import words from "./data/name-words.json" with { type: "json" };

// Built on the first pick: most commands never pick a name.
let pairs: ReadonlyArray<string> | undefined;
const adjectiveAnimalPairs = () =>
  (pairs ??= words.adjectives.flatMap((adjective) =>
    words.animals.map((animal) => `${adjective}-${animal}`),
  ));

export const pickWorktreeName = (
  used: ReadonlySet<string>,
  doubutsuNames: boolean,
) =>
  Effect.gen(function* () {
    const pool = doubutsuNames ? doubutsu.names : adjectiveAnimalPairs();
    const free = pool.filter((name) => !used.has(name));
    if (free.length > 0) {
      return free[
        yield* Random.nextIntBetween(0, free.length, { halfOpen: true })
      ] as string;
    }
    const base =
      pool[yield* Random.nextIntBetween(0, pool.length, { halfOpen: true })];
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base}-${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
  });
