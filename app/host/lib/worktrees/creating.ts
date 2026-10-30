// The Worktrees service's creates (../Worktrees.ts): a new worktree and
// an adopt, run by the engine with the host's create mark tied to the
// run's phases and its lifecycle scripts booked, and a landing's create,
// undone unless the landing keeps it.
import type {
  ConvertRefusedError,
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import {
  CarryOverReportSchema,
  type CreateWorktreeResult,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeLifecyclePhase,
  WorktreeLifecyclePhaseSchema,
  WorktreeSchema,
} from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
import type * as EngineWorktrees from "@shigomori/engine/Worktrees";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { log } from "@shared/log";
import * as Engine from "../Engine";
import * as Ops from "../engineOps";
import { findProject } from "../projects";
import * as Scripts from "../Scripts";
import { scriptEventOf } from "./documents";

// What a create's run tells the calling window or peer as it goes.
export type CreateNotifiers = {
  readonly notifyCreated?: (worktree: Worktree) => void;
  readonly notifyPhase: (payload: WorktreeLifecyclePhase) => void;
  readonly notifyCarryOverComplete: (
    payload: WorktreeCarryOverComplete,
  ) => void;
  readonly notifyScript: Scripts.NotifyScriptEvent;
};

export type CreateInput = {
  readonly projectId: string;
} & Parameters<typeof Ops.createWorktree>[1];

export type CreateFailure =
  | ConvertRefusedError
  | UnknownProjectError
  | UnknownWorktreeError
  | Engine.EngineCallError;

const decodeWorktree = Schema.decodeUnknownSync(WorktreeSchema);
const decodeCarryOverReport = Schema.decodeUnknownSync(CarryOverReportSchema);
const decodePhase = Schema.decodeUnknownSync(
  WorktreeLifecyclePhaseSchema.fields.phase,
);

export const makeCreating = (removing: {
  readonly forceRemove: (input: {
    readonly projectId: string;
    readonly worktreeId: string;
  }) => Effect.Effect<void, unknown, Engine.Services>;
}) =>
  Effect.gen(function* () {
    const scripts = yield* Scripts.Scripts;

    // A create's or an adopt's run, answered on its "created" event (the
    // app navigates at once) while it goes on to carry-over and setup in
    // the engine's scope (EngineRuns), or once it ended (`resolveOn`
    // "exit", for a caller that builds on the copy). A failure after
    // "created" still answers with the worktree: it only surfaces as the
    // run's lifecycle events, as it does after an early answer.
    //
    // `cancelled` stops the run, but only once "created" is in: an
    // interrupt inside `git worktree add` would leave a half-made checkout
    // nobody can name, and that one git command is all that comes before.
    // A run cancelled after it answers with its worktree like one whose
    // lifecycle step failed.
    const run = Effect.fnUntraced(function* (
      start: (
        reporter: EngineWorktrees.Reporter,
      ) => Effect.Effect<unknown, CreateFailure, Engine.Services>,
      projectId: string,
      notify: CreateNotifiers,
      options: {
        readonly resolveOn: "created" | "exit";
        readonly cancelled: Effect.Effect<void>;
      },
    ) {
      const { scope } = yield* Engine.EngineRuns;
      const made = yield* Deferred.make<Worktree, CreateFailure>();
      let created: Worktree | null = null;
      const booked = yield* scripts.lifecycleRuns(notify.notifyScript);
      // The create mark (which refuses a delete or move) opens and closes
      // with the phases the page disables its delete button on, so the
      // two agree. A run that dies mid-lifecycle never sends its "idle",
      // so the end closes an open phase itself.
      let phaseOpen = false;
      const setPhase = (id: string, phase: WorktreeLifecyclePhase["phase"]) => {
        if (phase === "idle") {
          if (!phaseOpen) return;
          phaseOpen = false;
          scripts.clearCreate(id);
        } else if (!phaseOpen) {
          phaseOpen = true;
          scripts.markCreate(id);
        }
        notify.notifyPhase({ projectId, worktreeId: id, phase });
      };
      const onEvent = (event: EngineWorktrees.WorktreeEvent) => {
        switch (event.event) {
          case "created": {
            created = decodeWorktree(event.worktree);
            Deferred.doneUnsafe(made, Exit.succeed(created));
            notify.notifyCreated?.(created);
            break;
          }
          case "phase": {
            if (!created) break;
            setPhase(created.id, decodePhase(event.phase));
            break;
          }
          case "carryOver": {
            if (!created) break;
            notify.notifyCarryOverComplete({
              projectId,
              worktreeId: created.id,
              report: decodeCarryOverReport(event.report),
            });
            break;
          }
          case "script":
            booked.forward(scriptEventOf(event));
            break;
        }
      };
      const reporter: EngineWorktrees.Reporter = {
        report: (event) =>
          Effect.sync(() => {
            // A schema mismatch before "created" fails the whole call;
            // after it the caller has its answer, so it is logged instead
            // of lost.
            try {
              onEvent(event);
            } catch (error) {
              if (created === null) {
                Deferred.doneUnsafe(
                  made,
                  Exit.fail(Engine.engineFailure(error, { projectId })),
                );
              } else {
                log.warn("[engine] mid-run event failed validation", error);
              }
            }
          }),
        color: true,
      };
      const running = Effect.result(start(reporter)).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            booked.end();
            // Before the run ends, so a caller sequencing work after it
            // (an undo that removes it) finds the mark cleared.
            if (created !== null) {
              setPhase(created.id, "idle");
              return;
            }
            Deferred.doneUnsafe(
              made,
              Exit.fail(
                Exit.isSuccess(exit) && Result.isFailure(exit.value)
                  ? exit.value.failure
                  : new Engine.EngineCallError({
                      reason: "The worktree was not created.",
                      cause: Exit.isFailure(exit) ? exit.cause : undefined,
                    }),
              ),
            );
          }),
        ),
      );
      const fiber = yield* Effect.forkIn(running, scope);
      yield* options.cancelled.pipe(
        Effect.andThen(Deferred.await(made)),
        Effect.andThen(Fiber.interrupt(fiber)),
        Effect.ignore,
        Effect.raceFirst(Fiber.await(fiber)),
        Effect.forkIn(scope),
      );
      const worktree = yield* Deferred.await(made);
      if (options.resolveOn === "exit") yield* Fiber.await(fiber);
      return { worktree } satisfies CreateWorktreeResult;
    });

    const create = Effect.fn("Worktrees.create")(function* (
      input: CreateInput,
      notify: CreateNotifiers,
      options: { readonly resolveOn?: "created" | "exit" } = {},
    ) {
      const project = yield* findProject(input.projectId);
      return yield* run(
        (reporter) => Ops.createWorktree(project, input, reporter),
        project.id,
        notify,
        { resolveOn: options.resolveOn ?? "created", cancelled: Effect.never },
      );
    });

    const adopt = Effect.fn("Worktrees.adopt")(function* (
      input: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly force: boolean;
      },
      notify: CreateNotifiers,
    ) {
      const project = yield* findProject(input.projectId);
      return yield* run(
        (reporter) =>
          Ops.adoptWorktree(project, input.worktreeId, input.force, reporter),
        project.id,
        notify,
        { resolveOn: "created", cancelled: Effect.never },
      );
    });

    // What undoes a create the landing didn't keep: the forced removal,
    // then the branch, which the create made and `sm rm` keeps when the
    // project is set to keep branches (a retry would meet it). Best
    // effort: what could not be removed is logged, and the landing still
    // answers with why it ended.
    const undo = (worktree: Worktree) =>
      Effect.gen(function* () {
        const project = yield* findProject(worktree.projectId);
        yield* removing.forceRemove({
          projectId: project.id,
          worktreeId: worktree.id,
        });
        yield* Effect.ignore(
          (yield* Git.Git).deleteBranch({
            repo: project.path,
            name: worktree.branch,
            force: true,
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "[worktrees] could not undo a create the landing didn't keep:",
            error,
          ),
        ),
      );

    // A landing's create (sync/landing.ts), on a new branch, its run whole
    // (resolveOn "exit"). Its commit point is `keep`, which the landing
    // calls once its last step is done: until then the close of the scope
    // it was made in undoes it, whatever ended that scope; after, only an
    // interrupt does (a cancel at a later step of the move). The engine's
    // "created" is what there is to undo: a cancel before it waits for it
    // (see `run`) and stops the run, and one that came while the run had
    // not made the worktree has nothing to undo. The create runs on a
    // fiber of that scope, waited on interruptibly, and the undo waits for
    // its answer, so a cancel reaches the run through `cancelled` and its
    // setup script dies with it.
    const createHeld = Effect.fn("Worktrees.createHeld")(function* (
      input: CreateInput & { readonly branchName: string },
      notify: CreateNotifiers,
    ) {
      const project = yield* findProject(input.projectId);
      const cancelled = yield* Deferred.make<void>();
      let kept = false;
      const created = yield* Effect.acquireRelease(
        run(
          (reporter) => Ops.createWorktree(project, input, reporter),
          project.id,
          notify,
          { resolveOn: "exit", cancelled: Deferred.await(cancelled) },
        ).pipe(Effect.forkScoped),
        (fiber, exit) =>
          kept && !Exit.hasInterrupts(exit)
            ? Effect.void
            : Deferred.succeed(cancelled, undefined).pipe(
                Effect.andThen(Fiber.await(fiber)),
                Effect.flatMap((answer) =>
                  Exit.isSuccess(answer)
                    ? undo(answer.value.worktree)
                    : Effect.void,
                ),
              ),
      );
      const { worktree } = yield* Fiber.join(created);
      return {
        worktree,
        keep: Effect.sync(() => {
          kept = true;
        }),
      };
    });

    return { create, adopt, createHeld };
  });
