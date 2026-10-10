// The app's calls into the engine that owns the data model: every
// worktree and project mutation (create, adopt, delete, done, merge,
// move, the shelf and auto-pull marks, agent sessions and hooks, project
// add, remove and reorder)
// and every read of what the engine owns (worktree rows and identities,
// the project list and icons, the stored config, the launcher row,
// package scripts). The app and a terminal run the same services, and
// each function answers in the shape `sm --json` printed, decoded
// against the shared schemas, so drift fails loudly here instead of
// surfacing as undefined-flavored breakage in the renderer.
//
// The narrowed engine face: the operations themselves are effects
// (engineOps.ts), and these are their Promises, for the host code not
// converted yet. Removed by step 7's B4c PR (V3.md, the host's Promise
// adapters), with its last importer.
import * as Effect from "effect/Effect";
import { onAbort } from "@host/lib/util/abort";
import { run, type Services } from "./engine";
import * as Ops from "./engineOps";

const face =
  <Args extends unknown[], A, E>(
    op: (...args: Args) => Effect.Effect<A, E, Services>,
  ) =>
  (...args: Args): Promise<A> =>
    run(op(...args));

// A move's cancel, as the effect a create waits on.
const cancelledBy = (signal: AbortSignal | undefined): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<void>((resume) => {
        const off = onAbort(signal, () => resume(Effect.void));
        return Effect.sync(off);
      });

export const createWorktree = (
  project: Parameters<typeof Ops.createWorktree>[0],
  input: Parameters<typeof Ops.createWorktree>[1],
  notify: Parameters<typeof Ops.createWorktree>[2],
  opts: { resolveOn?: "created" | "exit"; signal?: AbortSignal } = {},
) =>
  run(
    Ops.createWorktree(project, input, notify, {
      ...(opts.resolveOn === undefined ? {} : { resolveOn: opts.resolveOn }),
      cancelled: cancelledBy(opts.signal),
    }),
  );
export const adoptWorktree = face(Ops.adoptWorktree);
export const deleteWorktree = face(Ops.deleteWorktree);
export const deleteStack = face(Ops.deleteStack);
export const forceRemoveWorktree = face(Ops.forceRemoveWorktree);
export const finishWorktree = face(Ops.finishWorktree);
export const mergePullRequest = face(Ops.mergePullRequest);
export const setShelved = face(Ops.setShelved);
export const addProject = face(Ops.addProject);
export const packageScriptLaunch = face(Ops.packageScriptLaunch);
export const writeGlobalConfig = face(Ops.writeGlobalConfig);
export const writeProjectConfig = face(Ops.writeProjectConfig);
export const removeProject = face(Ops.removeProject);
export const relocateProject = face(Ops.relocateProject);
export const setAutoPull = face(Ops.setAutoPull);
export const idleAgents = face(Ops.idleAgents);
export const unbindAgent = face(Ops.unbindAgent);
export const resumeAgent = face(Ops.resumeAgent);
export const agentHarnesses = face(Ops.agentHarnesses);
export const setAgentHooks = face(Ops.setAgentHooks);
export const moveWorktree = face(Ops.moveWorktree);
export const renameWorktree = face(Ops.renameWorktree);
export const rekeyWorktree = face(Ops.rekeyWorktree);
export const storeProjectOrder = face(Ops.storeProjectOrder);
export const wtFolderMovedTo = face(Ops.wtFolderMovedTo);
export const listWorktrees = face(Ops.listWorktrees);
export const describeWorktree = face(Ops.describeWorktree);
export const listWorktreeIdentities = face(Ops.listWorktreeIdentities);
export const listProjects = face(Ops.listProjects);
export const projectIcon = face(Ops.projectIcon);
export const worktreeDestination = face(Ops.worktreeDestination);
export const readGlobalConfig = face(Ops.readGlobalConfig);
export const readProjectConfig = face(Ops.readProjectConfig);
export const diskUsage = face(Ops.diskUsage);
export const launcherRow = face(Ops.launcherRow);
export const launcherCatalog = face(Ops.launcherCatalog);
export const packageScripts = face(Ops.packageScripts);
export const runDoctor = face(Ops.runDoctor);
export const dirtyCapture = face(Ops.dirtyCapture);
export const dirtyApply = face(Ops.dirtyApply);
export const bundleCreate = face(Ops.bundleCreate);
export const bundleUnpack = face(Ops.bundleUnpack);
export const openLauncher = face(Ops.openLauncher);
