// Worktrees' adopting: an external checkout taken under management,
// and setup run again in a worktree.
import { sanitizeBranchForPath } from "@shigomori/contracts/predicates/worktreeDirName";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Layout from "../Layout.ts";
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
    const layout = yield* Layout.Layout;
    const path = yield* Path.Path;
    const { projectSettings, identities, row } = listing;
    const { provision, createLifecycle, addWorktree, occupied } = creating;
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
      // Adopting re-checks-out the branch tip, so what is uncommitted goes.
      yield* requireClean(worktree, options.force, "adopt", "adopting");
      const name = worktree.detached
        ? worktree.branch
        : sanitizeBranchForPath(worktree.branch);
      // Refused before the wipe below: the add's own check runs after the
      // old folder is gone.
      if (name !== "") {
        const clash = (yield* identities(project)).some(
          (other) =>
            other.id !== worktree.id &&
            other.name.toLowerCase() === name.toLowerCase(),
        );
        if (clash) {
          return yield* new WorktreeRefused({
            reason: "name-taken",
            subject: name,
          });
        }
        // A folder at the managed place would refuse the add after the
        // wipe too.
        const place = path.join(yield* layout.worktreeBase(project), name);
        if (yield* occupied(place)) {
          return yield* new WorktreeRefused({
            reason: "destination-taken",
            subject: place,
          });
        }
      }
      // From the wipe to the re-key nothing may cut in: the checkout is
      // gone until the add makes it again.
      const { made, found, cloned } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* removeCheckout(project.path, worktree.path, true);
          yield* registry.setMark("shelved", worktree.id, false);
          const added = yield* addWorktree(project, {
            name,
            branch: "",
            base: worktree.branch,
            checkout: true,
            clone: true,
          });
          // The checkout moved, so its id did too, like after a move.
          if (added.made.id !== worktree.id) {
            yield* kept.rekey(project, worktree.id, added.made.id);
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
        "",
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

export type AdoptingArea = Effect.Success<ReturnType<typeof makeAdopting>>;
