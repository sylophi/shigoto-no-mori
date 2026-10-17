// Worktrees' adopting: an external checkout taken under management,
// and setup run again in a worktree.
import { sanitizeBranchForPath } from "@shigomori/contracts/predicates/worktreeDirName";
import * as Effect from "effect/Effect";
import * as Registry from "../Registry.ts";
import { type Located, type Reporter, WorktreeRefused } from "./documents.ts";
import type { ListingArea } from "./listing.ts";
import type { CreatingArea } from "./creating.ts";
import type { RemovingArea } from "./removing.ts";
import type { KeptArea } from "./kept.ts";

export const makeAdopting = ({
  listing,
  creating,
  removing,
  kept,
}: {
  readonly listing: ListingArea;
  readonly creating: CreatingArea;
  readonly removing: RemovingArea;
  readonly kept: KeptArea;
}) =>
  Effect.gen(function* () {
    const registry = yield* Registry.Registry;
    const { projectSettings, row } = listing;
    const { provision, createLifecycle, addWorktree } = creating;
    const { requireClean, removeCheckout } = removing;

    const adopt = Effect.fn("Worktrees.adopt")(function* (
      located: Located,
      options: { readonly force: boolean },
      reporter: Reporter,
    ) {
      const { project, worktree } = located;
      if (worktree.isPrimary) {
        return yield* new WorktreeRefused({
          reason: "adopt-primary",
          subject: "",
        });
      }
      if (!worktree.isExternal) {
        return yield* new WorktreeRefused({
          reason: "adopt-managed",
          subject: "",
        });
      }
      // git won't remove a locked checkout, which would leave both.
      if (worktree.locked) {
        return yield* new WorktreeRefused({
          reason: "adopt-locked",
          subject: worktree.path,
        });
      }
      // Adopting re-checks-out the branch tip, so what is uncommitted goes.
      yield* requireClean(worktree, options.force, "adopt", "adopting");
      const name = worktree.detached
        ? worktree.branch
        : sanitizeBranchForPath(worktree.branch);
      // The replacement first, then the checkout it replaces, which the
      // replacement goes again for if it can't: a crash between leaves
      // both on the branch, never neither, and the add claims its place
      // as git makes it. A detached one's tip is the new checkout's HEAD
      // from the add on.
      const { made, found, cloned } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const added = yield* addWorktree(project, {
            name,
            branch: "",
            base: worktree.branch,
            checkout: true,
            clone: true,
            replacing: worktree.id,
          });
          yield* removeCheckout(project.path, worktree.path, true).pipe(
            Effect.onError(() =>
              Effect.ignore(
                removeCheckout(project.path, added.made.path, true),
              ),
            ),
          );
          yield* registry.setMark("shelved", worktree.id, false);
          // The checkout moved, so its id did too, like after a move.
          // An adopt takes only a clean checkout, so there is no capture
          // to carry; one that failed to follow is said, not fatal.
          if (added.made.id !== worktree.id) {
            yield* kept
              .rekey(project, worktree.id, added.made.id)
              .pipe(
                Effect.catchTag("CaptureNotCarried", (error) =>
                  Effect.logWarning(error.message),
                ),
              );
          }
          return added;
        }),
      );
      const adopted = yield* row({ project, worktree: made });
      if (cloned !== undefined)
        yield* reporter.report({ event: "cloned", cloned });
      yield* reporter.report({ event: "created", worktree: adopted });
      const failures = yield* createLifecycle(
        project,
        made,
        found,
        Effect.succeed(""),
        false,
        reporter,
      );
      return { worktree: adopted, failures };
    });

    const setup = Effect.fn("Worktrees.setup")(function* (
      located: Located,
      reporter: Reporter,
    ) {
      const { settings } = yield* projectSettings(located.project);
      const outcome = yield* provision(
        located.project,
        located.worktree,
        settings,
        false,
        reporter,
      );
      if (outcome.ran.length > 0) {
        yield* reporter.report({ event: "phase", phase: "idle" });
      }
      return outcome;
    });
    return { adopt, setup };
  });
