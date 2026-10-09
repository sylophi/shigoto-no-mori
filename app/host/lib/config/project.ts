// A project's settings and a worktree's own data, in the store. The
// project-wide settings (scripts, layout, ...) are read and written
// through the engine's Config (host/lib/engineCalls.ts), as `sm projects
// config` does. A worktree's data is the custom ports the app adds and
// the title and description `sm describe` sets, each kept beside the
// other.
import * as WorktreeData from "@shigomori/engine/WorktreeData";
import * as Effect from "effect/Effect";
import type {
  ShigomoriConfig,
  ShigomoriWorktreeData,
  WorktreeDescription,
} from "@shigomori/contracts/schemas";
import * as Engine from "@host/lib/engine";
import { readProjectConfig } from "@host/lib/engineCalls";

// A worktree's key, for the caches keyed by one.
export function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export function parseWorktreeKey(key: string): {
  projectId: string;
  worktreeId: string;
} {
  const [projectId, worktreeId, ...extra] = key.split(":");
  if (projectId === undefined || worktreeId === undefined || extra.length > 0) {
    throw new Error(`worktree key ${key} is not projectId:worktreeId`);
  }
  return { projectId, worktreeId };
}

export function readShigomoriConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  return readProjectConfig(projectId);
}

const onData = <A>(
  f: (data: WorktreeData.WorktreeData["Service"]) => Effect.Effect<A>,
): Promise<A> =>
  Engine.run(
    Effect.gen(function* () {
      return yield* f(yield* WorktreeData.WorktreeData);
    }),
  );

// The document as the renderer has always read it: each field present
// only when set.
export async function readWorktreeData(
  projectId: string,
  worktreeId: string,
): Promise<ShigomoriWorktreeData | null> {
  const [described, ports] = await onData((data) =>
    Effect.all([
      data.description(projectId, worktreeId),
      data.ports(projectId, worktreeId),
    ]),
  );
  const doc: ShigomoriWorktreeData = {
    ...(ports.length > 0 && { ports: [...ports] }),
    ...(described.title !== "" && { title: described.title }),
    ...(described.description !== "" && {
      description: described.description,
    }),
    ...(described.describedAt > 0 && { describedAt: described.describedAt }),
  };
  return Object.keys(doc).length === 0 ? null : doc;
}

// The renderer's write: the custom ports, the title and description
// kept.
export async function writeWorktreeData(
  projectId: string,
  worktreeId: string,
  { ports }: Pick<ShigomoriWorktreeData, "ports">,
): Promise<void> {
  await Engine.change(
    Effect.gen(function* () {
      yield* (yield* WorktreeData.WorktreeData).setPorts(
        projectId,
        worktreeId,
        ports ?? [],
      );
    }),
  );
}

// The title and description as a whole: what a worktree carries to its
// copy on another device. Only a pair described after the one stored
// lands, so a carry that read a stale side can't undo a newer describe.
export async function writeWorktreeDescription(
  projectId: string,
  worktreeId: string,
  { title, description, describedAt }: WorktreeDescription,
): Promise<void> {
  await Engine.change(
    Effect.gen(function* () {
      yield* (yield* WorktreeData.WorktreeData).carry(projectId, worktreeId, {
        title: title ?? "",
        description: description ?? "",
        describedAt: describedAt ?? 0,
      });
    }),
  );
}
