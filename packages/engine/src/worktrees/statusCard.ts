// Worktrees' status card: one worktree's sync against its upstream and
// its base, its changes, stashes and ports, as `sm status` shows it.
import { isSafeRelPath } from "@shigomori/contracts/predicates/relPath";
import { isUntracked } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { findExecutable } from "../executables.ts";
import * as Git from "../Git.ts";
import * as GitHub from "../GitHub.ts";
import { matchPorts, parsePortPoolConfig, PORT_POOL_CONFIG } from "../ports.ts";
import {
  type Located,
  NO_CHANGES,
  type StatusCard,
  UNKNOWN_BRANCH,
  isAgentWorking,
  isShelved,
  nonEmpty,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";

export const makeStatusCard = ({
  listing,
}: {
  readonly listing: ListingArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const github = yield* GitHub.GitHub;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const { deviceFlag, primaryRefOf, marks, descriptionOf } = listing;
    const changeCounts = (worktree: string) =>
      git.changedFiles(worktree).pipe(
        Effect.map((files) => {
          const counts = { ...NO_CHANGES, changedCount: files.length };
          for (const file of files) {
            if (isUntracked(file)) counts.untracked++;
            else if (file.conflicted) counts.conflicted++;
            else {
              if (file.staged !== "none") counts.staged++;
              if (file.staged !== "all") counts.unstaged++;
            }
          }
          return counts;
        }),
        Effect.orElseSucceed(() => ({ ...NO_CHANGES, changedCount: null })),
      );

    const stashCount = (worktree: string) =>
      git.run(worktree, ["stash", "list"]).pipe(
        Effect.map(
          (stdout) =>
            stdout.split("\n").filter((line) => line.trim() !== "").length,
        ),
        Effect.orElseSucceed(() => 0),
      );

    const readOptional = (file: string) =>
      fs
        .readFileString(file)
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));

    // The worktree's port-pool config and the ports port-pool wrote into
    // its env files: what the status card and the app's port list read.
    const poolPorts = Effect.fn("Worktrees.poolPorts")(function* (
      worktree: string,
    ) {
      const config = parsePortPoolConfig(
        yield* readOptional(path.join(worktree, PORT_POOL_CONFIG)),
      );
      const files = new Map(
        (yield* Effect.forEach(
          // A name that would leave the worktree is no env file of its.
          Object.keys(config.envFiles).filter(isSafeRelPath),
          (name) =>
            readOptional(path.join(worktree, name)).pipe(
              Effect.map((content) => [name, content] as const),
            ),
          { concurrency: "unbounded" },
        )).flatMap(([name, content]) =>
          content === undefined ? [] : [[name, content] as const],
        ),
      );
      return { config, ports: matchPorts(config, files) };
    });

    // The ports port-pool provisioned here, and whether it is set up.
    const portsOf = (worktree: string) =>
      Effect.gen(function* () {
        const [{ config, ports }, enabled, installed] = yield* Effect.all([
          poolPorts(worktree),
          deviceFlag("portPool"),
          findExecutable("port-pool").pipe(
            Effect.map(Option.isSome),
            Effect.provideContext(platform),
          ),
        ]);
        return {
          ports,
          portPool: { enabled, installed, configured: config.configured },
        };
      });

    const status = Effect.fn("Worktrees.status")(function* (
      located: Located,
      options: { readonly pullRequest: boolean },
    ) {
      const { project, worktree } = located;
      const lookup: Effect.Effect<
        GitHub.Lookup<GitHub.PullRequestCard> & { readonly skipped?: true }
      > = !options.pullRequest
        ? Effect.succeed({ found: null, skipped: true as const })
        : worktree.detached || worktree.branch === UNKNOWN_BRANCH
          ? Effect.succeed({ found: null, unavailable: "no branch to look up" })
          : github.cardFor(project.path, worktree.branch);
      const probes = yield* Effect.all(
        {
          pr: lookup,
          described: descriptionOf(worktree),
          counts: changeCounts(worktree.path),
          stashes: stashCount(worktree.path),
          commits: git.listCommits(worktree.path, { skip: 0, count: 1 }),
          upstream: git.upstreamSync(worktree.path),
          // The base divergence needs the primary ref, so it is asked
          // beside it.
          context: Effect.all(
            {
              primary: primaryRefOf(project).pipe(
                Effect.flatMap((primary) =>
                  git.aheadBehind(worktree.path, primary.primaryRef).pipe(
                    Effect.map((base) =>
                      Object.assign({}, primary, {
                        base: Option.map(base, (sync) =>
                          Object.assign({ ref: primary.primaryRef }, sync),
                        ),
                      }),
                    ),
                  ),
                ),
              ),
              marked: marks,
            },
            { concurrency: 2 },
          ),
          ports: portsOf(worktree.path),
        },
        { concurrency: "unbounded" },
      );
      const { primary, marked } = probes.context;
      const { title, description } = probes.described;
      const scripts = primary.settings?.["scripts"];
      const script = (key: "setup" | "teardown") => {
        const value = Predicate.isObject(scripts) ? scripts[key] : undefined;
        return nonEmpty(key, typeof value === "string" ? value : "");
      };
      return {
        id: worktree.id,
        projectId: worktree.projectId,
        projectName: project.name,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        isPrimary: worktree.isPrimary,
        isExternal: worktree.isExternal,
        detached: worktree.detached,
        shelved: isShelved(worktree, marked.shelved),
        ...nonEmpty("title", title),
        ...nonEmpty("description", description),
        git: {
          upstream: probes.upstream.hasUpstream
            ? { ahead: probes.upstream.ahead, behind: probes.upstream.behind }
            : null,
          base: Option.getOrNull(primary.base),
          ...probes.counts,
          stashCount: probes.stashes,
          lastCommit: probes.commits[0] ?? null,
        },
        ...probes.ports,
        scripts: { ...script("setup"), ...script("teardown") },
        pr: probes.pr.found,
        ...(probes.pr.found === null
          ? nonEmpty("prUnavailable", probes.pr.unavailable ?? "")
          : {}),
        ...(probes.pr.skipped ? { prSkipped: true as const } : {}),
        autoPull: marked.autoPull.has(worktree.id),
        agentWorking: isAgentWorking(worktree, marked),
        ...nonEmpty("primaryBranch", primary.primaryBranch),
      } satisfies StatusCard;
    });

    return { readOptional, poolPorts, status };
  });

export type StatusCardArea = Effect.Success<ReturnType<typeof makeStatusCard>>;
