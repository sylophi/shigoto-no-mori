import { fsContract } from "@shigomori/contracts/modules/fs";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Git from "@shigomori/engine/Git";
import * as Projects from "@shigomori/engine/Projects";
import type * as Engine from "@host/lib/Engine";
import { listFolder, listVolumes } from "@host/lib/folders";
import { toAbsolute } from "@shared/paths";

export const fsHandlers = {
  listDirectory: ({ path }) => listFolder(path),

  listVolumes: () => listVolumes,

  // `git rev-parse --git-dir` validates a real working repo: catches
  // missing/corrupted .git, bare repos, and linked worktrees alike.
  isGitRepo: ({ path }) =>
    Effect.flatMap(Git.Git, (git) => git.isRepo(toAbsolute(path))),

  scanForGitRepos: ({ path }) =>
    Effect.flatMap(Projects.Projects, (projects) =>
      projects.scan(toAbsolute(path)),
    ).pipe(Effect.map((found) => found.repos)),
} satisfies EffectHandlers<
  typeof fsContract,
  unknown,
  Engine.Services | ChildProcessSpawner.ChildProcessSpawner
>;
