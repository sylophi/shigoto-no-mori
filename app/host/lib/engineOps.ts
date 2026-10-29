// The app's calls into the engine that owns the data model: every
// worktree and project mutation (create, adopt, delete, done, merge,
// move, the shelf and auto-pull marks, agent sessions and hooks, project
// add, remove and reorder)
// and every read of what the engine owns (worktree rows and identities,
// the project list and icons, the stored config, the launcher row,
// package scripts). The app and a terminal run the same services, and
// each function answers in the shape `sm --json` prints, decoded
// against the shared schemas, so drift fails loudly here instead of
// surfacing as undefined-flavored breakage in the renderer.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { childDefaults } from "@shigomori/engine/processes";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EngineConfig from "@shigomori/engine/Config";
import * as Agents from "@shigomori/engine/Agents";
import * as Bundle from "@shigomori/engine/Bundle";
import * as Dirty from "@shigomori/engine/Dirty";
import * as Doctor from "@shigomori/engine/Doctor";
import { codeOf } from "@shigomori/engine/errorDocument";
import type { MergeMethod } from "@shigomori/contracts/schemas";
import * as Icons from "@shigomori/engine/Icons";
import * as Identity from "@shigomori/engine/Identity";
import * as Landing from "@shigomori/engine/Landing";
import * as Open from "@shigomori/engine/Open";
import * as Launchers from "@shigomori/engine/Launchers";
import * as Projects from "@shigomori/engine/Projects";
import * as Registry from "@shigomori/engine/Registry";
import * as Scripts from "@shigomori/engine/Scripts";
import * as SharedSettings from "@shigomori/engine/SharedSettings";
import * as ShellIntegration from "@shigomori/engine/ShellIntegration";
import * as Usage from "@shigomori/engine/Usage";
import * as WorktreeData from "@shigomori/engine/WorktreeData";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as WtFolder from "@shigomori/engine/WtFolder";
import {
  AgentHarnessStatusListSchema,
  CleanupErrorSchema,
  type CleanupError,
  type DeleteStackResult,
  DetectedLauncherSchema,
  type DeviceSettingsPatch,
  LauncherEntrySchema,
  type MergeOutcome,
  MergeOutcomeSchema,
  PackageScriptsDocSchema,
  type Project,
  ProjectIconSchema,
  ProjectRowSchema,
  ProjectSchema,
  type MovedSource,
  type CustomPort,
  type ProjectSettingsPatch,
  type ShigomoriConfig,
  type ShigomoriWorktreeData,
  StoredGlobalConfigSchema,
  StoredShigomoriConfigSchema,
  type WorktreeDescription,
  WorktreeIdentitySchema,
  WorktreeSchema,
} from "@shigomori/contracts/schemas";
import { DoctorReportSchema } from "@shigomori/contracts/modules/cli";
import type { SharedSettingsDoc } from "@shigomori/contracts/schemas/sharedSettings";
import { ConvertRefusedError } from "@shigomori/contracts/errors";
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import {
  asCall,
  asChange,
  changing,
  EngineCallError,
  engineFailure,
  locate,
  projectById,
  type Services,
} from "./Engine";

const decodeWorktree = Schema.decodeUnknownSync(WorktreeSchema);
const decodeCleanupError = Schema.decodeUnknownSync(CleanupErrorSchema);

const quiet: Landing.Reporter = { report: () => Effect.void, color: true };

// An unforced adopt stopped by its guard (the worktree's uncommitted
// changes, or a status that can't be read), as the contract's
// ConvertRefusedError.
function guardRefusal(error: unknown): ConvertRefusedError | null {
  const code = codeOf(error);
  if (code === "uncommitted-changes" || code === "status-unreadable") {
    return new ConvertRefusedError({ refusal: code });
  }
  return null;
}

type Ids = { projectId: string; worktreeId?: string };

// A create's or an adopt's run, as a change, its guard's refusal kept.
const asCreate = <A, E, R>(effect: Effect.Effect<A, E, R>, ids: Ids) =>
  changing(effect, ids, "create").pipe(
    Effect.mapError(
      (error) => guardRefusal(error) ?? engineFailure(error, ids),
    ),
  );

// The engine's create, every event of its run to `reporter`
// (host/lib/worktrees/creating.ts reads them).
export const createWorktree = (
  project: Project,
  input: {
    worktreeName?: string | undefined;
    branchName?: string | undefined;
    base?: string | undefined;
    checkout?: boolean | undefined;
    // false has git write every tracked file instead of cloning them.
    cloneFiles?: boolean | undefined;
    // Leave the project's setup script out (carry-over and port
    // provision still run): a mirror or transplant told not to set
    // the copy up.
    skipSetup?: boolean | undefined;
    ignoredFilesFollow?: readonly string[] | undefined;
  },
  reporter: Worktrees.Reporter,
) =>
  asCreate(
    Effect.gen(function* () {
      const registered = yield* projectById(project.id);
      return yield* (yield* Worktrees.Worktrees).create(
        registered,
        {
          name: input.worktreeName || undefined,
          branch: input.branchName || undefined,
          base: input.base || undefined,
          checkout: input.checkout,
          skipSetup: input.skipSetup,
          clone: input.cloneFiles !== false,
          ignoredFilesFollow: input.ignoredFilesFollow,
        },
        reporter,
      );
    }),
    { projectId: project.id },
  );

// force only once the user has seen the changes the convert wipes.
// Unforced, adopt refuses a dirty worktree, untracked files included,
// with the convert refusal guardRefusal maps.
export const adoptWorktree = (
  project: Project,
  worktreeId: string,
  force: boolean,
  reporter: Worktrees.Reporter,
) =>
  asCreate(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      return yield* (yield* Worktrees.Worktrees).adopt(
        located,
        { force },
        reporter,
      );
    }),
    { projectId: project.id, worktreeId },
  );

// A removal's account of a cleanup script that failed, which left the
// worktree in place.
export type Removal =
  | { ok: true; cleanupError?: undefined }
  | { ok: false; cleanupError: CleanupError };

// The engine's removal, the scripts it runs to `reporter`, each cleanup
// script on a clock of `cleanupWithin` ms when given.
export const deleteWorktree = Effect.fnUntraced(function* (
  project: Project,
  input: {
    worktreeId: string;
    force?: boolean | undefined;
    skipCleanup?: boolean | undefined;
    cleanupWithin?: number | undefined;
    expect?: MovedSource | undefined;
  },
  reporter: Worktrees.Reporter,
) {
  const removal = Effect.gen(function* () {
    const located = yield* locate(project.id, input.worktreeId);
    return yield* (yield* Worktrees.Worktrees)
      .remove(
        located,
        {
          force: input.force === true,
          keepBranch: false,
          skipCleanup: input.skipCleanup === true,
          ...(input.cleanupWithin === undefined
            ? {}
            : { cleanupWithin: input.cleanupWithin }),
          ...(input.expect === undefined ? {} : { expect: input.expect }),
        },
        reporter,
      )
      .pipe(
        Effect.as<Removal>({ ok: true }),
        Effect.catchTags({
          CleanupFailed: (failed) =>
            Effect.succeed<Removal>({
              ok: false,
              cleanupError: decodeCleanupError(
                Worktrees.cleanupErrorOf(failed),
              ),
            }),
        }),
      );
  });
  return yield* asChange(
    removal,
    { projectId: project.id, worktreeId: input.worktreeId },
    "remove",
  );
});

// The merged layers of a stack under the worktree `worktreeId` names,
// itself included: what deleteStack removes, resolved and checked.
export const planStack = Effect.fnUntraced(function* (
  project: Project,
  input: { worktreeId: string; force?: boolean; skipCleanup?: boolean },
) {
  return yield* asCall(
    Effect.gen(function* () {
      const located = yield* locate(project.id, input.worktreeId);
      return yield* (yield* Landing.Landing).planRemoveStack(located, {
        force: input.force === true,
        keepBranch: false,
        skipCleanup: input.skipCleanup === true,
      });
    }),
    { projectId: project.id, worktreeId: input.worktreeId },
  );
});

// The worktrees a stack's plan names, removed together. The document
// lists them: the worktree itself under `removed`, the others under
// `stack.removed`, and on a cleanup failure whatever went before it.
// `removedOther` hears each of the others as it goes, so a removal cut
// short still tells what went.
export const deleteStack = Effect.fnUntraced(function* (
  project: Project,
  removal: Landing.StackRemoval,
  reporter: Worktrees.Reporter,
  removedOther: (worktreeId: string) => void,
) {
  const doc = yield* asChange(
    Effect.flatMap(Landing.Landing, (landing) =>
      landing.removeStack(removal, {
        ...reporter,
        removedOther: (removed) => Effect.sync(() => removedOther(removed.id)),
      }),
    ),
    { projectId: project.id, worktreeId: removal.located.worktree.id },
    "remove",
  );
  const removed = removedIdsOf(doc);
  if (doc.ok === true) {
    return { ok: true, removed } satisfies DeleteStackResult;
  }
  if (doc.cleanupError !== undefined) {
    return {
      ok: false,
      removed,
      cleanupError: decodeCleanupError(doc.cleanupError),
    } satisfies DeleteStackResult;
  }
  return yield* new EngineCallError({
    reason: doc.error ?? "removing the stack failed",
    cause: doc,
  });
});

// The worktree ids a stack removal's document says went, the lower
// layers first and the worktree it ran from last, the order they were
// removed in.
function removedIdsOf(doc: Landing.Document): string[] {
  const ids = (doc.stack?.removed ?? []).map((entry) => entry.id);
  if (doc.removed) ids.push(doc.removed.id);
  return ids;
}

// Not forced: the cleanup box shows for a merged PR, but the branch can
// hold commits made since, which only `done`'s own proof refuses to
// delete.
export const finishWorktree = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
) {
  const doc = yield* asChange(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      return yield* (yield* Landing.Landing).done(located, { force: false });
    }),
    { projectId: project.id, worktreeId },
    "finish",
  );
  return decodeWorktree(doc["worktree"]);
});

// `stack`: the PR and every open PR under it in its stack, which the
// engine resolves and merges bottom first.
export const mergePullRequest = Effect.fnUntraced(function* (
  project: Project,
  number: number,
  method: MergeMethod,
  options: { stack?: boolean } = {},
) {
  const doc = yield* asChange(
    Effect.gen(function* () {
      const registered = yield* projectById(project.id);
      return yield* (yield* Landing.Landing).merge(
        { project: registered, number },
        { method, stack: options.stack === true },
        quiet,
      );
    }),
    { projectId: project.id },
    "merge",
  );
  return { outcome: mergeOutcomeOf(doc) };
});

const isMergeOutcome = Schema.is(MergeOutcomeSchema);

// The document spells the outcome the way MergeOutcomeSchema does. A
// document without one (a stack merge's) landed.
function mergeOutcomeOf(doc: Landing.Document): MergeOutcome {
  return isMergeOutcome(doc.outcome) ? doc.outcome : "merged";
}

export const setShelved = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  shelved: boolean,
) {
  yield* asChange(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      yield* (yield* Worktrees.Worktrees).setShelved(located.worktree, shelved);
    }),
    { projectId: project.id, worktreeId },
  );
});

export const addProject = Effect.fnUntraced(function* (
  path: string,
  terrier?: boolean,
) {
  const project = yield* asChange(
    Effect.flatMap(Projects.Projects, (projects) =>
      projects.add(path, { terrier }),
    ),
  );
  return yield* Schema.decodeEffect(ProjectSchema)(project);
});

// The command that runs a worktree's script (package.json, justfile,
// Makefile), and the SHIGOMORI_* values a run can't derive, for
// the app's registry to spawn (it keeps owning streaming, cancel, and
// quit-time reaping).
// The engine picks the tool that runs it (the manager the lockfile
// selects, just or make) and counts the run in the use log.
export const packageScriptLaunch = Effect.fnUntraced(function* (args: {
  projectId: string;
  worktreeId: string;
  scriptName: string;
}) {
  return yield* asChange(
    Effect.gen(function* () {
      const scripts = yield* Scripts.Scripts;
      const located = yield* locate(args.projectId, args.worktreeId);
      const { program, args: argv } = yield* scripts.command({
        worktree: located.worktree,
        script: args.scriptName,
        extra: [],
      });
      const context = yield* (yield* Worktrees.Worktrees).scriptContext(
        located,
      );
      yield* scripts.recordRun(located.project.id, args.scriptName);
      return {
        command: [program, ...argv].map(shellQuote).join(" "),
        scriptEnv: {
          projectBranch: context.projectBranch,
          defaultBranch: context.defaultBranch,
          title: context.title,
          description: context.description,
        },
      };
    }),
    { projectId: args.projectId, worktreeId: args.worktreeId },
  );
});

// The Settings form's save, and a peer's: the engine's patch, in one
// transaction with the terminal's own writes.
export const patchGlobalConfig = Effect.fnUntraced(function* (
  patch: DeviceSettingsPatch,
) {
  yield* asChange(
    Effect.flatMap(EngineConfig.Config, (engineConfig) =>
      engineConfig.patch(patch),
    ),
  );
});

// A project's settings scope.
const projectScope = (projectId: string) =>
  Effect.map(projectById(projectId), (project) => ({
    kind: "project" as const,
    projectId: project.id,
    path: project.path,
  }));

export const patchProjectConfig = Effect.fnUntraced(function* (
  projectId: string,
  patch: ProjectSettingsPatch,
) {
  yield* asChange(
    Effect.gen(function* () {
      const scope = yield* projectScope(projectId);
      yield* (yield* EngineConfig.Config).patchProject(scope, patch);
    }),
    { projectId },
  );
});

// The proofs' fixture: the project's settings as a whole document.
export const writeProjectConfig = Effect.fnUntraced(function* (
  projectId: string,
  config: ShigomoriConfig,
) {
  yield* asChange(
    Effect.gen(function* () {
      const scope = yield* projectScope(projectId);
      const engineConfig = yield* EngineConfig.Config;
      yield* engineConfig.write(
        scope,
        config,
        (yield* engineConfig.read(scope)) ?? {},
      );
    }),
    { projectId },
  );
});

// Registry removal and per-project state deletion only; the app-side
// extras (script reaping, icon cache) stay with the caller because
// those registries live in the app's process.
export const removeProject = Effect.fnUntraced(function* (projectId: string) {
  yield* asChange(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      yield* (yield* Projects.Projects).remove(project);
    }),
    { projectId },
  );
});

// What deleteProject refuses, checked alone.
export const checkDeletable = Effect.fnUntraced(function* (projectId: string) {
  yield* asCall(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      yield* (yield* Projects.Projects).checkDeletable(project);
    }),
    { projectId },
  );
});

// The removal with its worktrees and repo folder deleted too.
export const deleteProject = Effect.fnUntraced(function* (
  projectId: string,
  reporter: Worktrees.Reporter,
) {
  yield* asChange(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      yield* (yield* Projects.Projects).removeWithFiles(project, reporter);
    }),
    { projectId },
  );
});

// Repoints the registry entry at the moved repo and reconnects its
// worktrees, answering the project at its new path.
export const relocateProject = Effect.fnUntraced(function* (
  projectId: string,
  path: string,
) {
  const row = yield* asChange(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Worktrees.Worktrees).relocateProject(project, path);
    }),
    { projectId },
  );
  const project = yield* Schema.decodeEffect(ProjectSchema)(row);
  return project;
});

// ---- Worktree marks and moves ----

// A worktree's on/off mark, answered with the worktree's refreshed row.
const setMark = Effect.fnUntraced(function* (
  set: (
    worktrees: Worktrees.Worktrees["Service"],
  ) => (
    worktree: Worktrees.WorktreeIdentity,
    on: boolean,
  ) => Effect.Effect<void, Worktrees.MarkRefused>,
  project: Project,
  worktreeId: string,
  on: boolean,
) {
  const row = yield* asChange(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const located = yield* locate(project.id, worktreeId);
      yield* set(worktrees)(located.worktree, on);
      return yield* worktrees.row(located);
    }),
    { projectId: project.id, worktreeId },
  );
  return decodeWorktree(row);
});

// The auto-pull mark. The pull itself stays with the app's fetch sweep
// (host/lib/worktrees/autoPullSweep.ts).
export const setAutoPull = (
  project: Project,
  worktreeId: string,
  autoPull: boolean,
) =>
  setMark((worktrees) => worktrees.setAutoPull, project, worktreeId, autoPull);

// ---- Agent sessions and their harnesses' hooks (engine Agents) ----

// A worktree's refreshed row after `edit` changed what is kept for it.
const rowAfter = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  edit: (located: Worktrees.Located) => Effect.Effect<void, unknown, Services>,
) {
  const row = yield* asChange(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      yield* edit(located);
      return yield* (yield* Worktrees.Worktrees).row(located);
    }),
    { projectId: project.id, worktreeId },
  );
  return decodeWorktree(row);
});

// The worktree's title, description or both (`sm describe`): the open
// pull request's while one holds them, else its own. Gives the PR it
// edited, as it now reads.
export const describe = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  change: { readonly title?: string; readonly description?: string },
) {
  let editedPullRequest = null as { readonly title: string } | null;
  const worktree = yield* rowAfter(project, worktreeId, (located) =>
    Effect.flatMap(Effect.service(Worktrees.Worktrees), (worktrees) =>
      worktrees.describe(located, change).pipe(
        Effect.map((result) => {
          editedPullRequest = result.pullRequest;
        }),
      ),
    ),
  );
  return { worktree, editedPullRequest };
});

// Every agent session bound to the worktree goes idle.
export const idleAgents = (project: Project, worktreeId: string) =>
  rowAfter(project, worktreeId, (located) =>
    Effect.flatMap(Effect.service(Agents.Agents), (agents) =>
      agents.idle(located.worktree),
    ),
  );

// Unbinds one agent session from the worktree it is bound to.
export const unbindAgent = (
  project: Project,
  worktreeId: string,
  harness: string,
  session: string,
) =>
  rowAfter(project, worktreeId, () =>
    Effect.flatMap(Effect.service(Agents.Agents), (agents) =>
      agents.unbind({ harness, session }),
    ),
  );

// Resumes one agent session in the worktree, in the user's terminal. It
// writes no state, so it is no change the busy prompt counts, while
// macOS may hold it on an Automation prompt.
export const resumeAgent = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  harness: string,
  session: string,
) {
  yield* asCall(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      yield* (yield* Agents.Agents).resume(located, { harness, session });
    }),
    { projectId: project.id, worktreeId },
  );
});

// Opens the user's agent on a guide session the shell minted for one of
// its windows. Like a resume, it writes no state.
export const launchGuide = (input: Agents.GuideLaunch) =>
  asCall(
    Effect.flatMap(Effect.service(Agents.Agents), (agents) =>
      agents.guide(input),
    ),
  );

const decodeHarnesses = Schema.decodeUnknownSync(AgentHarnessStatusListSchema);

export const agentHarnesses = Effect.fnUntraced(function* () {
  return [
    ...decodeHarnesses(
      yield* asCall(
        Effect.flatMap(Effect.service(Agents.Agents), (a) => a.statuses),
      ),
    ),
  ];
});

// Installs or removes one harness's hooks, answered with every
// harness's status.
export const setAgentHooks = Effect.fnUntraced(function* (
  harness: string,
  install: boolean,
) {
  return [
    ...decodeHarnesses(
      yield* asChange(
        Effect.gen(function* () {
          const agents = yield* Agents.Agents;
          yield* agents.setHooks([harness], install);
          return yield* agents.statuses;
        }),
      ),
    ),
  ];
});

// Removes every harness's hooks this flavor installed (a nuke). A
// harness not set up here is skipped.
export const removeAllAgentHooks = Effect.suspend(() =>
  asChange(
    Effect.flatMap(Effect.service(Agents.Agents), (agents) =>
      agents.setHooks([], false),
    ),
  ),
);

// `git worktree move` plus the re-key of everything stored under the
// worktree's path-derived id (marks, its data, a pending dirty capture).
// The host's guards around it are the Worktrees service's
// (worktrees/moving.ts).
export const moveWorktree = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  destinationPath: string,
) {
  const moved = yield* asChange(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      return yield* (yield* Worktrees.Worktrees).move(located, destinationPath);
    }),
    { projectId: project.id, worktreeId },
    "move",
  );
  return decodeWorktree(moved.worktree);
});

// A move to the same parent under a new folder name, checked as
// create checks a custom name.
export const renameWorktree = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  name: string,
) {
  const renamed = yield* asChange(
    Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
      worktrees.rename(project, worktreeId, name),
    ),
    { projectId: project.id, worktreeId },
    "move",
  );
  return decodeWorktree(renamed.worktree);
});

export const storeProjectOrder = Effect.fnUntraced(function* (ids: string[]) {
  yield* asChange(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      yield* registry.reorder(yield* registry.listed, ids);
    }),
  );
});

// ---- Reads ----

// Where the v3 migration moved a v2 worktree folder, null when it
// didn't.
export const wtFolderMovedTo = Effect.fnUntraced(function* (fromPath: string) {
  const moved = yield* asCall(
    Effect.flatMap(WtFolder.WtFolder, (folder) => folder.movedTo(fromPath)),
  );
  return Option.getOrNull(moved);
});

// The id each worktree a recorded move took had, to the one it has
// now (WtFolder.movedIds).
export const wtFolderMovedIds = Effect.suspend(() =>
  asCall(Effect.flatMap(WtFolder.WtFolder, (folder) => folder.movedIds)),
);

const decodeWorktrees = Schema.decodeUnknownSync(Schema.Array(WorktreeSchema));
const decodeWorktreeIdentities = Schema.decodeUnknownSync(
  Schema.Array(WorktreeIdentitySchema),
);

// A project's rows, primary first: the sidebar's list. A project whose
// checkouts git can't list reads as having none, as the terminal's
// listing skips it.
export const listWorktrees = Effect.fnUntraced(function* (projectId: string) {
  const listing = yield* asCall(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Worktrees.Worktrees).list([project]);
    }),
    { projectId },
  );
  return decodeWorktrees(listing.rows);
});

// One row, freshly probed: what a mutation hands back to the renderer.
export const describeWorktree = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
) {
  const row = yield* asCall(
    Effect.gen(function* () {
      const located = yield* locate(projectId, worktreeId);
      return yield* (yield* Worktrees.Worktrees).row(located, {
        settle: true,
      });
    }),
    { projectId, worktreeId },
  );
  return decodeWorktree(row);
});

// Identities without git probes (see WorktreeIdentitySchema): a
// project's (or, with no projectId, every project's), or the one
// `worktreeId` names. `primaryRef` adds the project's primary ref.
export const listWorktreeIdentities = Effect.fnUntraced(function* (
  scope: { projectId?: string; worktreeId?: string },
  opts: { primaryRef?: boolean } = {},
) {
  const options = { primaryRef: opts.primaryRef === true };
  const rows = yield* asCall(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const at = yield* worktrees.nowhere;
      if (scope.worktreeId !== undefined) {
        const located = yield* worktrees.resolve(at, scope);
        return [yield* worktrees.identityRow(located, options)];
      }
      const projects =
        scope.projectId === undefined
          ? at.projects
          : [yield* worktrees.resolveProjectById(at, scope.projectId)];
      return (yield* worktrees.identityList(projects, options)).rows;
    }),
    scope,
  );
  return decodeWorktreeIdentities(rows);
});

const decodeProjectRows = Schema.decodeUnknownSync(
  Schema.Array(ProjectRowSchema),
);
const decodeProjectIcon = Schema.decodeUnknownSync(
  Schema.NullOr(ProjectIconSchema),
);

// The repo's identity (what makes the same project on two devices the
// same repo), or null.
export const repoIdentity = (projectPath: string) =>
  Effect.flatMap(Identity.Identity, (identity) =>
    Effect.map(identity.of(projectPath), (repo) => repo.identity),
  );

// Every listed project as the registry holds it, none of the rows'
// probes run.
export const listedProjects = Effect.flatMap(
  Registry.Registry,
  (registry) => registry.listed,
);

// Every registered project, terrier's merged in, decorated for the
// sidebar. `refreshIcons` re-scans projects the icon cache remembers
// as icon-less (the first list of a session).
export const listProjects = Effect.fnUntraced(function* (
  opts: { refreshIcons?: boolean } = {},
) {
  const rows = yield* asCall(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.rows({ rescanIconMisses: opts.refreshIcons === true }),
    ),
  );
  return decodeProjectRows(rows);
});

// The icon's bytes, or null. A remembered miss is scanned again: the
// renderer asks once per project per session, and an icon added since
// the miss was cached must show.
export const projectIcon = Effect.fnUntraced(function* (projectId: string) {
  const icon = yield* asCall(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Icons.Icons).bytes(project.path, {
        rescanMisses: true,
      });
    }),
    { projectId },
  );
  return decodeProjectIcon(Option.getOrNull(icon));
});

const decodeWorktreeDestination = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    taken: Schema.Boolean,
  }),
);

// Where a new worktree would land, and under what name: `name` when
// given (then `taken` says whether a worktree already holds the name
// or something the path), else a freshly picked free one.
export const worktreeDestination = Effect.fnUntraced(function* (
  projectId: string,
  name?: string,
) {
  const destination = yield* asCall(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Worktrees.Worktrees).destination(
        project,
        name ?? "",
      );
    }),
    { projectId },
  );
  return decodeWorktreeDestination(destination);
});

const decodeGlobalConfig = Schema.decodeUnknownSync(StoredGlobalConfigSchema);

// The device's settings as stored: unknown keys kept, no defaults
// filled in (callers apply their own, as they always have).
export const readGlobalConfig = Effect.fnUntraced(function* () {
  const stored = yield* asCall(
    Effect.flatMap(EngineConfig.Config, (engineConfig) =>
      engineConfig.read({ kind: "device" }),
    ),
  );
  return decodeGlobalConfig(stored ?? {});
});

const decodeProjectConfig = Schema.decodeUnknownSync(
  Schema.NullOr(StoredShigomoriConfigSchema),
);

// The project's settings as stored, or null when it has none.
export const readProjectConfig = Effect.fnUntraced(function* (
  projectId: string,
) {
  const stored = yield* asCall(
    Effect.gen(function* () {
      const scope = yield* projectScope(projectId);
      return yield* (yield* EngineConfig.Config).read(scope);
    }),
    { projectId },
  );
  return decodeProjectConfig(stored);
});

const decodeLauncherRow = Schema.decodeUnknownSync(
  Schema.Struct({
    entries: Schema.Array(LauncherEntrySchema),
    hiddenCount: Schema.Natural,
  }),
);

// The project's launcher row: installed tools, the GitHub entry and
// custom commands, hidden ones left out, most used first.
export const launcherRow = Effect.fnUntraced(function* (projectId: string) {
  const row = yield* asCall(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Launchers.Launchers).row(project);
    }),
    { projectId },
  );
  return decodeLauncherRow(row);
});

const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Array(DetectedLauncherSchema),
);

// Every tool the catalog knows, installed or not, by label.
export const launcherCatalog = Effect.fnUntraced(function* () {
  const apps = yield* asCall(
    Effect.flatMap(Launchers.Launchers, (launchers) => launchers.catalog),
  );
  return decodeCatalog(apps);
});

const decodePackageScripts = Schema.decodeUnknownSync(PackageScriptsDocSchema);

// The worktree's scripts, or null when it has no package.json, justfile
// or Makefile, or none of them reads. A worktree or project that is gone
// still fails.
export const packageScripts = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
) {
  const listed = yield* asCall(
    Effect.gen(function* () {
      const located = yield* locate(projectId, worktreeId);
      // Missing and unparseable read the same: no scripts to offer.
      return yield* (yield* Scripts.Scripts)
        .list({
          projectId: located.project.id,
          worktreePath: located.worktree.path,
        })
        .pipe(
          Effect.catchTags({
            NoScripts: () => Effect.succeed(null),
            UnreadableScripts: () => Effect.succeed(null),
          }),
        );
    }),
    { projectId, worktreeId },
  );
  return listed === null ? null : decodePackageScripts(listed);
});

// A wedged git or gh probe must not leave Settings' health check
// spinning forever. A fix runs the checklist twice (before and after
// the repairs), so it gets twice the budget.
const DOCTOR_TIMEOUT_MS = 60_000;

const decodeDoctorReport = Schema.decodeUnknownSync(DoctorReportSchema);

// The doctor's checklist. `fix` applies every repair: the Repair
// button's confirm is the consent the terminal asks for per repair.
// `zdotdir` is the login shell's, so the shell-hook check reads the
// .zshrc a terminal would; the doctor reads it once when it is built,
// so a run with one builds a doctor of its own. `version` and
// `executable` are the app's and its bundled `sm`'s, which the app
// check compares against the installed bundle.
export const runDoctor = Effect.fnUntraced(function* (
  fix: boolean,
  input: { version: string; executable: string; zdotdir?: string },
) {
  const doctor =
    input.zdotdir === undefined
      ? Effect.service(Doctor.Doctor)
      : Effect.provide(
          Effect.service(Doctor.Doctor),
          Doctor.layer.pipe(
            Layer.provide(childDefaults),
            Layer.provide(NodeServices.layer),
            Layer.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromEnv({ env: { ZDOTDIR: input.zdotdir } }),
                { asPrimary: true },
              ),
            ),
          ),
        );
  const run = Effect.gen(function* () {
    return yield* (yield* doctor).run({
      version: input.version,
      executable: input.executable,
      terminal: false,
      ...(fix
        ? {
            fix: {
              approve: () => Effect.succeed(true),
              failed: () => Effect.void,
            },
          }
        : {}),
    });
  }).pipe(Effect.timeout(fix ? 2 * DOCTOR_TIMEOUT_MS : DOCTOR_TIMEOUT_MS));
  const report = yield* fix ? asChange(run) : asCall(run);
  return decodeDoctorReport(report);
});

// ---- The device-sync plumbing ----

// The worktree's uncommitted changes as a commit under
// refs/shigomori/dirty/<id>, for a move to carry. A clean worktree
// captures nothing.
export const dirtyCapture = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
) {
  const captured = yield* asChange(
    Effect.gen(function* () {
      const { worktree } = yield* locate(project.id, worktreeId);
      return yield* (yield* Dirty.Dirty).capture({
        projectPath: project.path,
        worktreePath: worktree.path,
        worktreeId: worktree.id,
      });
    }),
    { projectId: project.id, worktreeId },
  );
  return captured.captured
    ? { captured: true, commit: captured.commit }
    : { captured: false };
});

// The capture replayed onto the worktree, which must be on the commit
// it was taken on, and the ref consumed.
export const dirtyApply = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
) {
  const applied = yield* asChange(
    Effect.gen(function* () {
      const { worktree } = yield* locate(project.id, worktreeId);
      return yield* (yield* Dirty.Dirty).apply(
        {
          projectPath: project.path,
          worktreePath: worktree.path,
          worktreeId: worktree.id,
        },
        { force: false },
      );
    }),
    { projectId: project.id, worktreeId },
  );
  return { applied: true, ...applied };
});

// The paths handed to bundle create and unpack are always app-chosen
// temp paths (the source link, host/lib/sync/sourceLink.ts, owns them).
export const bundleCreate = Effect.fnUntraced(function* (
  project: Project,
  outPath: string,
  refs: string[],
  haves: string[],
) {
  return yield* asCall(
    Effect.gen(function* () {
      return yield* (yield* Bundle.Bundle).create(
        project.path,
        outPath,
        refs,
        haves,
      );
    }),
    { projectId: project.id },
  );
});

// Into a registered project, or into a repository by path: the clone
// from a peer (host/lib/sync/cloneFromPeer.ts) unpacks into a folder
// it registers only once it is a checkout.
export const bundleUnpack = Effect.fnUntraced(function* (
  target: Project | { path: string },
  inPath: string,
  refspecs: string[],
) {
  const fetched = yield* asChange(
    Effect.gen(function* () {
      return yield* (yield* Bundle.Bundle).unpack(
        target.path,
        inPath,
        refspecs,
      );
    }),
    "id" in target ? { projectId: target.id } : {},
  );
  return { fetched: [...fetched] };
});

// Launches a launcher-row entry (`app:…`, `custom:…`, `web:github`) in
// the worktree, which also counts the use.
export const openLauncher = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  launcherId: string,
) {
  yield* asChange(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      yield* (yield* Open.Open).open(located, launcherId);
    }),
    { projectId: project.id, worktreeId },
  );
});

// A worktree's file, its path relative to the worktree's root, in the
// editor the device settings name or its default app.
export const openFile = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
  path: string,
) {
  yield* asCall(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      yield* (yield* Open.Open).edit(located, path);
    }),
    { projectId: project.id, worktreeId },
  );
});

// ---- A worktree's own data (host/lib/config/project.ts) ----

// The document as the renderer has always read it: each field present
// only when set.
export const readWorktreeData = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
) {
  const data = yield* WorktreeData.WorktreeData;
  const [described, ports] = yield* Effect.all([
    data.description(projectId, worktreeId),
    data.ports(projectId, worktreeId),
  ]);
  const doc: ShigomoriWorktreeData = {
    ...(ports.length > 0 && { ports: [...ports] }),
    ...(described.title !== "" && { title: described.title }),
    ...(described.description !== "" && {
      description: described.description,
    }),
    ...(described.describedAt > 0 && { describedAt: described.describedAt }),
  };
  return Object.keys(doc).length === 0 ? null : doc;
});

// The renderer's write: the custom ports by number, the title and
// description kept.
export const patchWorktreePorts = (
  projectId: string,
  worktreeId: string,
  patch: {
    readonly remove?: ReadonlyArray<number> | undefined;
    readonly put?: ReadonlyArray<CustomPort> | undefined;
  },
) =>
  asChange(
    Effect.flatMap(WorktreeData.WorktreeData, (data) =>
      data.patchPorts(projectId, worktreeId, patch),
    ),
  );

// The proofs' fixture: the custom ports as a whole.
export const writeWorktreeData = (
  projectId: string,
  worktreeId: string,
  { ports }: Pick<ShigomoriWorktreeData, "ports">,
) =>
  asChange(
    Effect.flatMap(WorktreeData.WorktreeData, (data) =>
      data.setPorts(projectId, worktreeId, ports ?? []),
    ),
  );

// The title and description as a whole: what a worktree carries to its
// copy on another device. Only a pair described after the one stored
// lands, so a carry that read a stale side can't undo a newer describe.
export const writeWorktreeDescription = (
  projectId: string,
  worktreeId: string,
  { title, description, describedAt }: WorktreeDescription,
) =>
  asChange(
    Effect.flatMap(WorktreeData.WorktreeData, (data) =>
      data.carry(projectId, worktreeId, {
        title: title ?? "",
        description: description ?? "",
        describedAt: describedAt ?? 0,
      }),
    ),
  );

// ---- This device, its usage log and its shared settings ----

export const deviceId = Effect.flatMap(
  Registry.Registry,
  (registry) => registry.deviceId,
);

// One use of a project, for the sidebar's usage sorts.
export const recordProjectUse = (projectId: string) =>
  Effect.flatMap(Usage.Usage, (usage) =>
    usage.record("project", projectId, ""),
  );

export const readSharedSettings = Effect.flatMap(
  SharedSettings.SharedSettings,
  (settings) => settings.read,
);

export const storeSharedSettings = (doc: SharedSettingsDoc) =>
  Effect.flatMap(SharedSettings.SharedSettings, (settings) =>
    settings.update(() => doc),
  );

// ---- The terminal's shell integration (host/lib/cli/shell.ts) ----

// One of the shell integration's calls, on the login shell `shell`.
export const onShell = <A, E>(
  shell: ShellIntegration.HookShell,
  f: (
    integration: ShellIntegration.ShellIntegration["Service"],
    shell: ShellIntegration.HookShell,
  ) => Effect.Effect<A, E>,
) =>
  asCall(
    Effect.flatMap(ShellIntegration.ShellIntegration, (integration) =>
      f(integration, shell),
    ),
  );

// ---- The package scripts' arrangement (host/lib/scripts/packageScriptStats.ts) ----

export const onScripts = <A>(
  f: (scripts: Scripts.Scripts["Service"]) => Effect.Effect<A>,
  change = false,
) => (change ? asChange : asCall)(Effect.flatMap(Scripts.Scripts, f));
