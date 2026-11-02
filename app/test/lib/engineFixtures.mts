// The proofs' reads and writes of what the engine keeps, straight on its
// services: a project's settings, a worktree's data and rows.
import type {
  ShigomoriConfig,
  ShigomoriWorktreeData,
} from "@shigomori/contracts/schemas";
import * as EngineConfig from "@shigomori/engine/Config";
import * as Identity from "@shigomori/engine/Identity";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as WorktreeData from "@shigomori/engine/WorktreeData";
import * as Effect from "effect/Effect";
import {
  findProject,
  findProjectAndWorktree,
  worktreeRow,
} from "../../host/lib/projects/index.ts";

// The project's settings as stored, or null when it has none.
export const readProjectConfig = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* findProject(projectId);
    return yield* (yield* EngineConfig.Config).readProject(
      EngineConfig.projectScope(project),
    );
  });

// The project's settings as a whole document.
export const writeProjectConfig = (
  projectId: string,
  config: ShigomoriConfig,
) =>
  Effect.gen(function* () {
    const scope = EngineConfig.projectScope(yield* findProject(projectId));
    const engineConfig = yield* EngineConfig.Config;
    yield* engineConfig.write(
      scope,
      config,
      (yield* engineConfig.read(scope)) ?? {},
    );
  });

export const readWorktreeData = (projectId: string, worktreeId: string) =>
  Effect.flatMap(WorktreeData.WorktreeData, (data) =>
    data.document(projectId, worktreeId),
  );

// The custom ports as a whole.
export const writeWorktreeData = (
  projectId: string,
  worktreeId: string,
  { ports }: Pick<ShigomoriWorktreeData, "ports">,
) =>
  Effect.flatMap(WorktreeData.WorktreeData, (data) =>
    data.setPorts(projectId, worktreeId, ports ?? []),
  );

export const repoIdentity = (path: string) =>
  Effect.flatMap(Identity.Identity, (identity) =>
    Effect.map(identity.of(path), (repo) => repo.identity),
  );

// A project's identities, primary first.
export const worktreeIdentities = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* findProject(projectId);
    const listing = yield* (yield* Worktrees.Worktrees).identityList(
      [project],
      { primaryRef: false },
    );
    return listing.rows;
  });

// One worktree's row, freshly probed.
export const describeWorktree = (projectId: string, worktreeId: string) =>
  Effect.flatMap(findProjectAndWorktree(projectId, worktreeId), worktreeRow);

// The worktree's title, as `sm describe` sets it.
export const setTitle = (
  projectId: string,
  worktreeId: string,
  title: string,
) =>
  Effect.gen(function* () {
    const located = yield* findProjectAndWorktree(projectId, worktreeId);
    yield* (yield* Worktrees.Worktrees).describe(located, { title });
  });
