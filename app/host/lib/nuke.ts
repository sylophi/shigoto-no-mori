// "Nuke everything" implementation: removes every worktree shigomori created
// (forced, so each one's port-pool lease is released and
// its teardown runs like any other removal) and wipes the shigomori data
// dir so state, global config, and any orphan worktree directories all go
// away.
//
// The original project repos on disk are untouched. We only act on data
// shigomori itself owns.
import { rm } from "node:fs/promises";
import type { NukeProgress, Project } from "@shigomori/contracts/schemas";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ops from "./engineOps";
import { pruneStaleWorktrees } from "./git/worktrees";
import { findProjectInsideDataDir, freshProjects } from "./projects";
import { clearDeleteInflight, markDeleteInflight } from "./scripts";
import { fromPromise } from "./util/fromPromise";
import { dataDir } from "./util/paths";
import { log } from "@shared/log";

class NukeRefusedError extends Schema.TaggedError<NukeRefusedError>()(
  "NukeRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const nukeEverything = Effect.fnUntraced(function* <R>(
  onProgress: (progress: NukeProgress) => void,
  // Every script's kill chain, waited for (host/lib/scripts).
  killAllScripts: Effect.Effect<void, never, R>,
) {
  const projects = yield* freshProjects;
  // The final step rm -rf's the shigomori data dir. A trapped project repo
  // would be wiped with it: .git, uncommitted work, everything.
  // Refuse up front, before any script kill or worktree removal.
  const trapped = findProjectInsideDataDir(projects);
  if (trapped) {
    return yield* new NukeRefusedError({
      reason:
        `Refusing to nuke: project "${trapped.name}" lives inside ` +
        `${dataDir()}, which would be deleted with it. ` +
        "Move the repository out first.",
    });
  }
  // Reap every running script first. Dev servers and watchers may have
  // their cwd inside the worktrees we're about to force-remove. Skipping
  // this would orphan them with deleted working directories, still
  // holding their ports, exactly what the per-worktree delete path
  // guards against via killScriptsForWorktree.
  onProgress({ phase: "scripts" });
  yield* killAllScripts;

  // List every project's worktrees up front so all targets can be
  // marked delete-inflight for the whole wipe. Skip externals:
  // shigomori didn't create them, so we shouldn't delete them when
  // wiping our own state. (sm rm filters their branches the same way.)
  const perProject = yield* Effect.forEach(
    projects,
    (project) =>
      Ops.listWorktreeIdentities({ projectId: project.id }).pipe(
        Effect.map((identities) => ({
          project,
          targets: identities.filter((i) => !i.isPrimary && !i.isExternal),
        })),
        // Project repo might have moved or been deleted; nothing to clean
        // via git for this one. The data dir wipe below still happens.
        Effect.orElseSucceed(() => ({ project, targets: [] })),
      ),
    { concurrency: "unbounded" },
  );
  // Same inflight marking as the per-worktree delete: blocks a renderer
  // script run from landing in a directory mid-removal and keeps the
  // busy-quit prompt honest during the wipe. Held through the data dir rm
  // below. Clearing each id right after its removal
  // would leave a window where a script could spawn into a directory
  // the rm is about to take out.
  const marked = perProject.flatMap(({ targets }) => targets.map((t) => t.id));
  for (const id of marked) markDeleteInflight(id);
  yield* Effect.gen(function* () {
    let removed = 0;
    onProgress({ phase: "worktrees", done: 0, total: marked.length });
    // One removal at a time within a project: each one rewrites the
    // repo's worktree metadata and branch refs.
    yield* Effect.forEach(
      perProject,
      ({ project, targets }) =>
        Effect.forEach(
          targets,
          (target) =>
            removeForNuke(project, target.id).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  removed += 1;
                  onProgress({
                    phase: "worktrees",
                    done: removed,
                    total: marked.length,
                  });
                }),
              ),
            ),
          { discard: true },
        ),
      { concurrency: "unbounded", discard: true },
    );
    onProgress({ phase: "wipe" });
    yield* fromPromise(() => rm(dataDir(), { recursive: true, force: true }));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const id of marked) clearDeleteInflight(id);
      }),
    ),
  );
  // The data dir rm wipes any managed-root worktree dirs whose removal
  // failed above, leaving stale admin entries behind. Sweep them per
  // project now that the dirs are gone.
  yield* Effect.forEach(
    projects,
    (p) => Effect.ignore(pruneStaleWorktrees(p.path)),
    { concurrency: "unbounded", discard: true },
  );
});

// Through forceRemoveWorktree: the branch goes per the
// deleteBranchOnRemove setting, as with any removal. Best effort: the
// data dir wipe that follows takes whatever is left under the managed
// root.
const removeForNuke = (project: Project, worktreeId: string) =>
  Ops.forceRemoveWorktree(project, worktreeId).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        log.warn(`[nuke] ${project.name}: ${errorMessageOf(error)}`),
      ),
    ),
  );
