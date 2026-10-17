// The doctor's run: the checks, the repairs they offer, and the checks again.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Paths from "../Paths.ts";
import {
  type DoctorDocument,
  type Entry,
  type RunInput,
  counts,
  errorText,
  findingOf,
} from "./documents.ts";

export const makeFinishing = Effect.gen(function* () {
  const paths = yield* Paths.Paths;
  const { dataDir, binaryName, flavor } = paths;
  // --- the run ---

  // The checks, then with `fix` the repairs they offer in checklist order
  // and the checks again, so the document describes the world after
  // them.
  const finish = <R>(
    input: RunInput,
    checks: Effect.Effect<ReadonlyArray<Entry<R>>, never, R>,
  ) =>
    Effect.gen(function* () {
      let entries = yield* checks;
      const repaired: string[] = [];
      const repairFailed: string[] = [];
      if (input.fix !== undefined) {
        const { approve, failed } = input.fix;
        for (const { repair } of entries) {
          if (repair === undefined) continue;
          const { apply, writesStore: _, ...asked } = repair;
          if (repair.destructive && !(yield* approve(asked))) continue;
          const outcome = yield* Effect.result(apply);
          if (Result.isFailure(outcome)) {
            const line = `couldn't ${repair.label}: ${errorText(outcome.failure)}`;
            yield* failed(line);
            repairFailed.push(line);
          } else {
            repaired.push(repair.label);
          }
        }
        if (repaired.length > 0) entries = yield* checks;
      }
      const summary = counts(entries);
      return {
        ok: summary.fail === 0,
        dataDir,
        flavor,
        version: input.version,
        binary: binaryName,
        summary,
        repaired,
        repairFailed,
        checks: entries.map(findingOf),
      } satisfies DoctorDocument;
    });

  return { finish };
});
