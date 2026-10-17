// Each project's pull requests by head branch, the sidebar's dots: read
// from gh, moved by what the host learns or does on GitHub, and its view
// (githubCli:watchProjectPullRequests) told on every change as the
// change lands, so no caller announces it.
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import {
  matchesMapEntry,
  type Project,
  type PullRequest,
  type PullRequestDetail,
  toSlimPullRequest,
} from "@shigomori/contracts/schemas";
import { elapsedMillis } from "@shigomori/engine/elapsed";
import type * as Git from "@shigomori/engine/Git";
import type * as GitHub from "@shigomori/engine/GitHub";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostPushes from "../HostPushes";
import * as GithubCli from "./GithubCli";
import {
  pullRequestMapsEqual,
  readBranchPullRequest,
  readProjectPullRequests,
  type SignedUrls,
  withSignedImages,
} from "./pullRequests";

// The project a map is kept for, and the checkout gh is asked in.
export type ProjectRef = Pick<Project, "id" | "path">;
type PullRequestMap = ReadonlyMap<string, PullRequest>;
type BranchReadError = Effect.Error<ReturnType<typeof readBranchPullRequest>>;

export class PullRequestMaps extends Context.Service<
  PullRequestMaps,
  {
    // The last map read while it is fresh, else one read now. Empty
    // while gh can't be asked about the project.
    readonly get: (project: ProjectRef) => Effect.Effect<PullRequestMap>;
    // A map read now: the sweep's, and a stack cleanup's. A failed read
    // answers the last map and leaves it to be read again.
    readonly refresh: (project: ProjectRef) => Effect.Effect<PullRequestMap>;
    // A page's read of its branch's PR, which moves the map where it is
    // newer. Null when the branch has none or gh can't be asked.
    readonly branchPullRequest: (
      project: ProjectRef,
      branch: string,
    ) => Effect.Effect<PullRequestDetail | null, BranchReadError>;
    // A title `sm describe` just set on the branch's PR.
    readonly retitled: (
      project: ProjectRef,
      branch: string,
      title: string,
    ) => Effect.Effect<void>;
    // A change made on GitHub (a merge, a draft toggle, a new PR, a
    // publish): the map is read again at its view's next read.
    readonly moved: (project: ProjectRef) => Effect.Effect<void>;
  }
>()("sm/host/PullRequestMaps") {}

// Monotonic, so a step of the wall clock neither keeps a map past this
// age nor drops one early. A Mac's sleep doesn't age it; the sweep reads
// the map again after a wake (BackgroundFetch's windows age by either
// clock).
const MAP_TTL_MS = 5 * 60_000;

const make = Effect.gen(function* () {
  const cli = yield* GithubCli.GithubCli;
  const pushes = yield* HostPushes.HostPushes;
  const gh = yield* Effect.context<
    Git.Git | GitHub.GitHub | ChildProcessSpawner.ChildProcessSpawner
  >();
  const maps = new Map<
    string,
    { readonly value: PullRequestMap; readonly readAt: number }
  >();
  const signedUrls: SignedUrls = new Map();
  const none: PullRequestMap = new Map();

  const announce = (project: ProjectRef) =>
    HostPushes.push(githubCliContract, "projectPullRequestsRefreshed", {
      projectId: project.id,
    }).pipe(Effect.provideService(HostPushes.HostPushes, pushes));

  const write = (project: ProjectRef, value: PullRequestMap, readAt: number) =>
    Effect.suspend(() => {
      const last = maps.get(project.id);
      maps.set(project.id, { value, readAt });
      return last && pullRequestMapsEqual(last.value, value)
        ? Effect.void
        : announce(project);
    });

  const read = Effect.fnUntraced(function* (project: ProjectRef) {
    const readAt = yield* elapsedMillis;
    const value = yield* readProjectPullRequests(project.path).pipe(
      Effect.provide(gh),
    );
    if (value === null) return maps.get(project.id)?.value ?? none;
    yield* write(project, value, readAt);
    return value;
  });

  const ready = (project: ProjectRef) =>
    Effect.map(cli.unavailableFor(project.path), (reason) => reason === null);

  const signer = (body: string, bodyHTML: string) =>
    Effect.gen(function* () {
      const now = {
        elapsed: yield* elapsedMillis,
        wall: yield* Clock.currentTimeMillis,
      };
      return withSignedImages(body, bodyHTML, signedUrls, now);
    });

  return PullRequestMaps.of({
    get: Effect.fn("PullRequestMaps.get")(function* (project: ProjectRef) {
      if (!(yield* ready(project))) return none;
      const last = maps.get(project.id);
      if (last && (yield* elapsedMillis) - last.readAt < MAP_TTL_MS) {
        return last.value;
      }
      return yield* read(project);
    }),
    refresh: Effect.fn("PullRequestMaps.refresh")(function* (
      project: ProjectRef,
    ) {
      if (!(yield* ready(project))) return none;
      return yield* read(project);
    }),
    branchPullRequest: Effect.fn("PullRequestMaps.branchPullRequest")(
      function* (project: ProjectRef, branch: string) {
        if (!(yield* ready(project))) return null;
        const pr = yield* readBranchPullRequest(
          project.path,
          branch,
          signer,
        ).pipe(Effect.provide(gh));
        const last = maps.get(project.id);
        if (last && !matchesMapEntry(pr, last.value.get(branch))) {
          const value = new Map(last.value);
          if (pr === null) value.delete(branch);
          else value.set(branch, toSlimPullRequest(pr));
          yield* write(project, value, last.readAt);
        }
        return pr;
      },
    ),
    retitled: Effect.fn("PullRequestMaps.retitled")(function* (
      project: ProjectRef,
      branch: string,
      title: string,
    ) {
      const last = maps.get(project.id);
      const pr = last?.value.get(branch);
      if (!last || !pr || pr.title === title) return;
      const value = new Map(last.value).set(branch, { ...pr, title });
      yield* write(project, value, last.readAt);
    }),
    moved: Effect.fn("PullRequestMaps.moved")(function* (project: ProjectRef) {
      const last = maps.get(project.id);
      if (last) {
        maps.set(project.id, { value: last.value, readAt: -Infinity });
      }
      yield* announce(project);
    }),
  });
});

export const layer = Layer.effect(PullRequestMaps, make);
