// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls, plus the project-wide PR cache
// refresh (sidebar dots). One timer, ticking only while someone is
// looking: a window here is focused, or a peer said so through
// git:sweep within its lease. An unattended sweep is a git and a gh
// spawn per project every minute that nobody reads, and whoever
// returns (this window on focus, a peer on its focus or its session
// landing) asks for a pass at that moment. Broadcasts refsRefreshed
// and projectPullRequestsRefreshed when a pass changed something so
// the renderer, local or peer, can invalidate.
import { errorMessageOf } from "@shigomori/contracts/errors";
import { gitContract } from "@shigomori/contracts/modules/git";
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import type * as GithubCli from "@host/lib/githubCli/GithubCli";
import { fetchAllRemotes, snapshotRemoteRefs } from "@host/lib/git/remotes";
import {
  pullRequestMapsEqual,
  readCachedProjectPullRequests,
  refreshProjectPullRequests,
} from "@host/lib/githubCli/pullRequests";
import { loadProjects } from "@host/lib/projects";
import { runningScriptWorktreeIds } from "@host/lib/scripts";
import { sweepAutoPull } from "@host/lib/worktrees/autoPullSweep";
import type { broadcastAll } from "@host/process/wires";
import { log } from "@shared/log";

// Skip if a fetch finished within this window. Short enough that rapid
// focus events don't feel stale, long enough that the focus, sweep and
// pre-action paths collapse onto one network round-trip.
const FRESHNESS_MS = 3_000;

// The timer's cadence while attended, and the staleness a peer's
// request tolerates: a peer asking is the peer catching up on what the
// timer would have kept within this age anyway, so a request landing
// on a host that is already ticking is nearly free. The PR refresh
// uses it on every path, since gh is a rate-limited API call and the
// open worktree page refreshes its own PR on focus.
const SWEEP_INTERVAL_MS = 60_000;

// A peer's request keeps the timer ticking this long, so a peer that
// renews once per interval never sees it lapse.
const ATTENTION_LEASE_MS = 2 * SWEEP_INTERVAL_MS;

export class BackgroundFetch extends Context.Service<
  BackgroundFetch,
  {
    // The explicit git:refreshProject request. Unlike the focus and
    // timer paths it always ends in an auto-pull pass: the renderer
    // sends it right after marking a worktree, and a fetch skipped as
    // fresh must not leave that first pull waiting for the minute
    // sweep.
    readonly refreshProject: (
      projectId: string,
      projectPath: string,
    ) => Effect.Effect<void>;
    // git:sweep. Answers with the lease so the peer knows how often to
    // renew.
    readonly sweepForPeer: Effect.Effect<{ leaseMs: number }>;
    // A window here gained or lost focus. Gaining it asks for a pass at
    // once: whoever returns sees refs as fresh as the sweep keeps them.
    readonly setWindowFocused: (focused: boolean) => void;
  }
>()("sm/host/BackgroundFetch") {}

type FetchServices =
  | Engine.Services
  | GithubCli.GithubCli
  | ChildProcessSpawner.ChildProcessSpawner;

// What a pass tells: the pushes on every wire, and a ref move the app
// made itself, announced as the git watcher would an external one.
export interface Options {
  readonly broadcast: typeof broadcastAll;
  readonly announceProjectChanged: (projectId: string) => void;
}

const make = ({ broadcast: broadcastAll, announceProjectChanged }: Options) =>
  Effect.gen(function* () {
    // What a pass reaches, as the layer finds it.
    const context = yield* Effect.context<FetchServices>();
    const runs = yield* FiberSet.make();
    // Signals from outside any effect (the shell's focus report).
    const inbox =
      yield* Queue.unbounded<Effect.Effect<void, never, FetchServices>>();
    const lastFetchedAt = new Map<string, number>();
    const fetchInFlight = new Map<string, Deferred.Deferred<boolean>>();
    const lastPullRequestSweepAt = new Map<string, number>();
    // Projects whose last fetch attempt failed, so a run of failures warns once.
    const failingProjects = new Set<string>();
    // Per project, the worktrees whose auto-pull failed on the last sweep,
    // so a run of failures warns once. Replaced whole on every sweep: a
    // worktree that stops failing (pulled, skipped, unmarked, removed)
    // drops out, and its next failure warns again.
    const failingAutoPulls = new Map<string, ReadonlySet<string>>();
    let attendedUntil = 0;
    // Whether a window of this machine is focused, as the shell reports it.
    let windowFocused = false;

    // Fast-forward the project's auto-pull worktrees (autoPullSweep.ts).
    // The merge is an app-run git command, so the git-directory watcher
    // drops its ref move as the app's own: the project-scoped announcement
    // the watcher would have made for an external pull comes from here.
    // Never fails: a failed pull is one worktree's problem and must not
    // read as a failed fetch.
    const autoPullProject = (projectId: string, projectPath: string) =>
      Effect.gen(function* () {
        const identities = yield* Ops.listWorktreeIdentities({ projectId });
        const { pulled, failed } = yield* sweepAutoPull(
          identities,
          runningScriptWorktreeIds(),
        );
        for (const { worktree, commits } of pulled) {
          log.info(
            `[auto-pull] ${worktree.path}: fast-forwarded ${commits} commit(s)`,
          );
        }
        const wasFailing = failingAutoPulls.get(projectId);
        for (const { worktree, message } of failed) {
          if (wasFailing?.has(worktree.id)) continue;
          log.warn(`[auto-pull] ${worktree.path}: ${message}`);
        }
        failingAutoPulls.set(
          projectId,
          new Set(failed.map((f) => f.worktree.id)),
        );
        if (pulled.length > 0) announceProjectChanged(projectId);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            log.warn(`[auto-pull] ${projectPath}: ${errorMessageOf(error)}`),
          ),
        ),
      );

    // Whether a fetch ran. Leaves refs stale on a failure and lets the
    // next attempt retry. Warns only on the way into the failed state:
    // lastFetchedAt advances on success only, so a project that stays
    // broken (offline, expired credentials) would otherwise warn on every
    // sweep, focus and navigation. Nothing else reports it.
    const fetchProject = (projectId: string, projectPath: string) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          broadcastAll(gitContract, "fetchActive", { projectId, active: true }),
        ),
        () =>
          Effect.gen(function* () {
            const before = yield* snapshotRemoteRefs(projectPath);
            yield* fetchAllRemotes(projectPath);
            lastFetchedAt.set(projectId, Date.now());
            failingProjects.delete(projectId);
            const after = yield* snapshotRemoteRefs(projectPath);
            if (before !== after) {
              broadcastAll(gitContract, "refsRefreshed", { projectId });
            }
            // After every successful fetch, not only one that moved a
            // ref: a marked worktree that was dirty or busy at the last
            // pass and is clean now has the same upstream and still wants
            // pulling.
            yield* autoPullProject(projectId, projectPath);
            return true;
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                if (!failingProjects.has(projectId)) {
                  failingProjects.add(projectId);
                  log.warn(`[fetch] ${projectPath}: ${errorMessageOf(error)}`);
                }
                return false;
              }),
            ),
          ),
        () =>
          Effect.sync(() =>
            broadcastAll(gitContract, "fetchActive", {
              projectId,
              active: false,
            }),
          ),
      );

    // Whether a fetch ran (false inside the freshness window). A request
    // landing while a fetch is running joins it rather than spawning a
    // second git behind the same network round trip.
    const maybeFetchProject = (
      projectId: string,
      projectPath: string,
      maxAgeMs = FRESHNESS_MS,
    ) =>
      Effect.suspend(() => {
        const ts = lastFetchedAt.get(projectId) ?? 0;
        if (Date.now() - ts < maxAgeMs) return Effect.succeed(false);
        const running = fetchInFlight.get(projectId);
        if (running) return Deferred.await(running);
        const fetching = Deferred.makeUnsafe<boolean>();
        fetchInFlight.set(projectId, fetching);
        return fetchProject(projectId, projectPath).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              fetchInFlight.delete(projectId);
              Deferred.doneUnsafe(fetching, exit);
            }),
          ),
        );
      });

    const sweepProjectPullRequests = (projectId: string, projectPath: string) =>
      Effect.suspend(() => {
        const ts = lastPullRequestSweepAt.get(projectId) ?? 0;
        if (Date.now() - ts < SWEEP_INTERVAL_MS) return Effect.void;
        lastPullRequestSweepAt.set(projectId, Date.now());
        const before = readCachedProjectPullRequests(projectPath);
        return refreshProjectPullRequests(projectPath).pipe(
          Effect.tap((after) =>
            Effect.sync(() => {
              if (!pullRequestMapsEqual(before, after)) {
                broadcastAll(
                  githubCliContract,
                  "projectPullRequestsRefreshed",
                  {
                    projectId,
                  },
                );
              }
            }),
          ),
          // PR data is decorative; swallow.
          Effect.ignore,
        );
      });

    // One pass over every project. The timer and the window-focus handler
    // take the fetch freshness default. A peer's request passes the sweep
    // interval: what it wants is the timer's guarantee, not a fresh fetch.
    // The last-read project list (host/lib/projects): every list the UI
    // reads refreshes it.
    const sweepProjects = (refsMaxAgeMs = FRESHNESS_MS) =>
      Effect.forEach(
        loadProjects(),
        (project) =>
          Effect.all(
            [
              FiberSet.run(
                runs,
                maybeFetchProject(project.id, project.path, refsMaxAgeMs),
              ),
              FiberSet.run(
                runs,
                sweepProjectPullRequests(project.id, project.path),
              ),
            ],
            { discard: true },
          ),
        { discard: true },
      );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Queue.take(inbox), (work) =>
          Effect.provide(work, context),
        ),
      ),
    );
    // The first pass, then a pass a minute while someone is looking.
    yield* sweepProjects();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(
          Effect.sleep(SWEEP_INTERVAL_MS),
          Effect.suspend(() =>
            windowFocused || Date.now() < attendedUntil
              ? sweepProjects()
              : Effect.void,
          ),
        ),
      ),
    );

    return BackgroundFetch.of({
      refreshProject: (projectId, projectPath) =>
        Effect.flatMap(maybeFetchProject(projectId, projectPath), (fetched) =>
          fetched ? Effect.void : autoPullProject(projectId, projectPath),
        ).pipe(Effect.provide(context)),
      sweepForPeer: Effect.suspend(() => {
        attendedUntil = Date.now() + ATTENTION_LEASE_MS;
        return Effect.as(sweepProjects(SWEEP_INTERVAL_MS), {
          leaseMs: ATTENTION_LEASE_MS,
        });
      }).pipe(Effect.provide(context)),
      setWindowFocused: (focused) => {
        windowFocused = focused;
        if (focused) Queue.offerUnsafe(inbox, sweepProjects());
      },
    });
  });

export const layer = (options: Options) =>
  Layer.effect(BackgroundFetch, make(options));
