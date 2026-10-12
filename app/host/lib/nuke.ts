// The host's half of "Nuke everything": what needs the store or a
// running host. It stops every script and terminal, removes every
// worktree the app created (forced, so each one's port-pool lease is
// released, its teardown runs and the managed folders it leaves empty
// go, like any removal), and takes this flavor's terminal command,
// shell hooks and agent hooks off the machine. The files (the data dir,
// userData, the logs) go at the next start, before anything opens them
// (main/electron/nuke.ts), so nothing is deleted under a running store.
//
// It refuses only for a trap: a data dir that would take the user's own
// files with it. Otherwise it does what it can and reports what it
// could not, with why. Every step reads what is there now, so a second
// run after an interrupted one finishes the job. The projects' repos,
// external worktrees and terrier's registry are never touched.
import { homedir } from "node:os";
import type {
  NukeProgress,
  NukeReport,
  Project,
} from "@shigomori/contracts/schemas";
import { errorWordsOf } from "@host/lib/errorWords";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Ops from "./engineOps";
import { pruneStaleWorktrees } from "./git/worktrees";
import { findProjectInsideDataDir, freshProjects } from "./projects";
import { clearDeleteInflight, markDeleteInflight } from "./scripts";
import { dataDir } from "@shared/paths";

class NukeRefusedError extends Schema.TaggedError<NukeRefusedError>()(
  "NukeRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

type Left = NukeReport["left"][number];

// Why the data dir can't go without the user's files: a project inside
// it, or the home folder (or above) as the data dir. Null when it can.
export function nukeTrap(
  projects: readonly Project[],
  root: string,
  home: string,
): string | null {
  if (isSameOrInside(home, root)) {
    return (
      `Refusing to nuke: the data folder is ${root}, which holds your ` +
      "home folder. Point SHIGOMORI_DATA_DIR or the data folder elsewhere first."
    );
  }
  const trapped = findProjectInsideDataDir(projects);
  if (trapped !== undefined) {
    return (
      `Refusing to nuke: project "${trapped.name}" lives inside ${root}, ` +
      "which would be deleted with it. Move the repository out first."
    );
  }
  return null;
}

// What `run` couldn't do, named `what`, or nothing when it did.
export const leftIf = <R>(
  what: string,
  run: Effect.Effect<unknown, unknown, R>,
): Effect.Effect<ReadonlyArray<Left>, never, R> =>
  Effect.map(Effect.exit(run), (exit) =>
    Exit.isFailure(exit)
      ? [{ what, why: errorWordsOf(Cause.squash(exit.cause)) }]
      : [],
  );

export const nukeEverything = Effect.fnUntraced(function* <R, U, P>(options: {
  readonly onProgress: (
    progress: NukeProgress,
  ) => Effect.Effect<void, never, P>;
  // Every script's kill chain, waited for (host/lib/scripts).
  readonly killAllScripts: Effect.Effect<void, never, R>;
  // Every terminal closed, none saved for the next start.
  readonly closeTerminals: Effect.Effect<void>;
  // Takes off what this flavor installed outside its folders (the
  // terminal command and its shell hooks, the agent hooks), answering
  // what it couldn't (leftIf).
  readonly uninstall: Effect.Effect<ReadonlyArray<Left>, never, U>;
  readonly home?: string;
}) {
  const { onProgress } = options;
  const projects = yield* freshProjects;
  // Refuse up front, before any script is stopped or worktree removed.
  const trap = nukeTrap(projects, dataDir(), options.home ?? homedir());
  if (trap !== null) return yield* new NukeRefusedError({ reason: trap });
  const left: Left[] = [];

  // Dev servers and watchers may have their cwd inside the worktrees
  // about to go: reap them first, or they'd hold their ports with their
  // directories deleted. The terminals likewise.
  yield* onProgress({ phase: "scripts" });
  yield* options.killAllScripts;
  yield* options.closeTerminals;

  // Every project's worktrees the app made, listed up front so all of
  // them are marked delete-inflight for the whole removal. Externals
  // were never the app's to delete.
  const perProject = yield* Effect.forEach(
    projects,
    (project) =>
      Ops.listWorktreeIdentities({ projectId: project.id }).pipe(
        Effect.map((identities) => ({
          project,
          targets: identities.filter((i) => !i.isPrimary && !i.isExternal),
        })),
        Effect.catch((error) =>
          Effect.sync(() => {
            left.push({
              what: `The worktrees of ${project.name}`,
              why: errorWordsOf(error),
            });
            return { project, targets: [] };
          }),
        ),
      ),
    { concurrency: "unbounded" },
  );
  const marked = perProject.flatMap(({ targets }) => targets.map((t) => t.id));
  for (const id of marked) markDeleteInflight(id);
  yield* Effect.gen(function* () {
    let removed = 0;
    yield* onProgress({ phase: "worktrees", done: 0, total: marked.length });
    // One removal at a time within a project: each one rewrites the
    // repo's worktree metadata and branch refs.
    yield* Effect.forEach(
      perProject,
      ({ project, targets }) =>
        Effect.gen(function* () {
          for (const target of targets) {
            const failed = yield* Ops.forceRemoveWorktree(
              project,
              target.id,
            ).pipe(
              Effect.as(null),
              Effect.catch((error) => Effect.succeed(errorWordsOf(error))),
            );
            // One inside the data dir goes with it at the next start.
            if (failed !== null && !isSameOrInside(target.path, dataDir())) {
              left.push({ what: target.path, why: failed });
            }
            removed += 1;
            yield* onProgress({
              phase: "worktrees",
              done: removed,
              total: marked.length,
            });
          }
          // A failed one's admin entry, whose folder may be gone.
          yield* Effect.ignore(pruneStaleWorktrees(project.path));
        }),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const id of marked) clearDeleteInflight(id);
      }),
    ),
  );

  yield* onProgress({ phase: "hooks" });
  left.push(...(yield* options.uninstall));
  return { left } satisfies NukeReport;
});
