// The app's calls into the engine that owns the data model: every
// worktree and project mutation (create, adopt, delete, done, merge,
// move, the shelf and auto-pull marks, project add, remove and reorder)
// and every read of what the engine owns (worktree rows and identities,
// the project list and icons, the stored config, the launcher row,
// package scripts). The app and a terminal run the same services, and
// each function answers in the shape `sm --json` printed, decoded
// against the shared schemas, so drift fails loudly here instead of
// surfacing as undefined-flavored breakage in the renderer.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as EngineConfig from "@shigomori/engine/Config";
import * as Doctor from "@shigomori/engine/Doctor";
import { codeOf } from "@shigomori/engine/errorDocument";
import type { MergeMethod } from "@shigomori/engine/GitHub";
import * as Hygiene from "@shigomori/engine/Hygiene";
import * as Icons from "@shigomori/engine/Icons";
import * as Landing from "@shigomori/engine/Landing";
import * as Launchers from "@shigomori/engine/Launchers";
import * as Projects from "@shigomori/engine/Projects";
import * as Registry from "@shigomori/engine/Registry";
import * as Scripts from "@shigomori/engine/Scripts";
import * as Worktrees from "@shigomori/engine/Worktrees";
import {
  CarryOverReportSchema,
  CleanupErrorSchema,
  type CleanupError,
  type CreateWorktreeResult,
  type DeleteStackResult,
  type DeleteWorktreeResult,
  type DetectedLauncher,
  DetectedLauncherSchema,
  type GlobalConfig,
  LauncherEntrySchema,
  type LauncherEntry,
  type MergeOutcome,
  MergeOutcomeSchema,
  modeledKeyPaths,
  type MergePullRequestResult,
  type PackageScriptsDoc,
  PackageScriptsDocSchema,
  type Project,
  type ProjectIcon,
  ProjectIconSchema,
  type ProjectRow,
  ProjectRowSchema,
  ProjectSchema,
  type ScriptEvent,
  ScriptEventSchema,
  type ShigomoriConfig,
  ShigomoriConfigSchema,
  StoredGlobalConfigSchema,
  StoredShigomoriConfigSchema,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeDiskUsage,
  WorktreeDiskUsageSchema,
  type WorktreeIdentity,
  WorktreeIdentitySchema,
  WorktreeLifecyclePhaseSchema,
  type WorktreeLifecyclePhase,
  WorktreeSchema,
} from "@shigomori/contracts/schemas";
import {
  type DoctorReport,
  DoctorReportSchema,
} from "@shigomori/contracts/modules/cli";
import {
  ConvertRefusedError,
  isEntityGoneError,
} from "@shigomori/contracts/errors";
import { forgetRepoIdentity } from "@host/lib/git/repoIdentity";
import {
  clearCreateInflight,
  cliScriptStream,
  markCreateInflight,
  type ScriptEnvValues,
} from "@host/lib/scripts";
import { shellQuote } from "@host/lib/util/shellQuote";
import { onAbort } from "@host/lib/util/abort";
import { log } from "@shared/log";
import {
  call,
  change,
  engineFailure,
  locate,
  projectById,
  type Services,
} from "./engine";

// Renderer-bound emit callbacks supplied by the IPC handler, fed from
// the engine's lifecycle events.
interface WorktreeOperationNotifiers {
  notifyPhase: (payload: WorktreeLifecyclePhase) => void;
  notifyCarryOverComplete: (payload: WorktreeCarryOverComplete) => void;
  notifyScript: (payload: ScriptEvent) => void;
}

const decodeWorktree = Schema.decodeUnknownSync(WorktreeSchema);
const decodeCarryOverReport = Schema.decodeUnknownSync(CarryOverReportSchema);
const decodeCleanupError = Schema.decodeUnknownSync(CleanupErrorSchema);
const decodeScriptEvent = Schema.decodeUnknownSync(ScriptEventSchema);
const decodePhase = Schema.decodeUnknownSync(
  WorktreeLifecyclePhaseSchema.fields.phase,
);

// A "script" event, as the script event it carries (the event tag
// itself is the reporter's, not the payload's).
function scriptEventOf(
  event: Extract<Worktrees.WorktreeEvent, { event: "script" }>,
): ScriptEvent {
  const { event: _event, ...scriptEvent } = event;
  return decodeScriptEvent(scriptEvent);
}

// A reporter that forwards the scripts a removal runs and nothing else.
const scriptReporter = (
  scripts: ReturnType<typeof cliScriptStream>,
): Landing.Reporter => ({
  report: (event) =>
    Effect.sync(() => {
      if (event.event === "script") scripts.forward(scriptEventOf(event));
    }),
  color: true,
});

const quiet: Landing.Reporter = { report: () => Effect.void, color: true };

// An unforced adopt stopped by its guard (the worktree's uncommitted
// changes, or a status that can't be read), as the contract's
// ConvertRefusedError.
function guardRefusal(error: unknown): Error | null {
  const code = codeOf(error);
  if (code === "uncommitted-changes" || code === "status-unreadable") {
    return new ConvertRefusedError({ refusal: code });
  }
  return null;
}

// Streamed create/adopt: resolve on the "created" event (the app
// navigates immediately) and keep forwarding lifecycle events to the
// renderer until the run ends. resolveOn "exit" waits out the WHOLE run
// instead (carry-over and setup included) for callers that sequence
// more work after the create, like the pull orchestration's dirty
// apply; a post-created failure still resolves, matching the
// early-resolve semantics where such failures only surface as
// lifecycle events.
//
// A cancel (`signal`, a move's) interrupts the run, but only once the
// "created" event is in: the worktree exists from that point and the
// caller can remove it, where an interrupt during `git worktree add`
// would leave a half-made checkout nobody can name. What precedes
// "created" is that one git command, so the wait is short. A run
// cancelled after "created" resolves with the worktree like any run
// whose lifecycle step failed, and the caller reads its own signal to
// know it must roll back.
function runStreamingCreate(
  start: (
    reporter: Worktrees.Reporter,
  ) => Effect.Effect<unknown, unknown, Services>,
  project: Project,
  worktreeId: string | undefined,
  notify: WorktreeOperationNotifiers,
  resolveOn: "created" | "exit" = "created",
  signal?: AbortSignal,
): Promise<CreateWorktreeResult> {
  return new Promise((resolve, reject) => {
    let created: Worktree | null = null;
    const scripts = cliScriptStream(notify.notifyScript);
    // The host's create mark (which refuses a delete or move) opens and
    // closes with the phases the page disables its delete button on,
    // so the two agree. A run that dies mid-lifecycle never sends its
    // "idle", so the end closes an open phase itself.
    let phaseOpen = false;
    const setPhase = (id: string, phase: WorktreeLifecyclePhase["phase"]) => {
      if (phase === "idle") {
        if (!phaseOpen) return;
        phaseOpen = false;
        clearCreateInflight(id);
      } else if (!phaseOpen) {
        phaseOpen = true;
        markCreateInflight(id);
      }
      notify.notifyPhase({ projectId: project.id, worktreeId: id, phase });
    };
    const kill = new AbortController();
    const offCancel = onAbort(signal, () => {
      if (created !== null) kill.abort();
    });
    const onEvent = (event: Worktrees.WorktreeEvent) => {
      switch (event.event) {
        case "created": {
          created = decodeWorktree(event.worktree);
          if (resolveOn === "created") resolve({ worktree: created });
          if (signal?.aborted) kill.abort();
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
            projectId: project.id,
            worktreeId: created.id,
            report: decodeCarryOverReport(event.report),
          });
          break;
        }
        case "script":
          scripts.forward(scriptEventOf(event));
          break;
      }
    };
    const reporter: Worktrees.Reporter = {
      report: (event) =>
        Effect.sync(() => {
          // A schema mismatch before "created" fails the whole call;
          // after it the promise is already resolved, so surface it as
          // a log instead of losing it.
          try {
            onEvent(event);
          } catch (error) {
            if (created === null) reject(error as Error);
            else log.warn("[engine] mid-run event failed validation", error);
          }
        }),
      color: true,
    };
    const ended = () => {
      scripts.end();
      if (created === null) return false;
      // Before resolving, so a caller sequencing work after the run (a
      // rollback that deletes it) finds the mark cleared.
      setPhase(created.id, "idle");
      if (resolveOn === "exit") resolve({ worktree: created });
      return true;
    };
    const ids = { projectId: project.id, worktreeId };
    change(Effect.result(start(reporter)), ids, { signal: kill.signal })
      .then(
        (result) => {
          if (ended() || result._tag === "Success") return;
          reject(
            guardRefusal(result.failure) ?? engineFailure(result.failure, ids),
          );
        },
        (error: Error) => {
          if (!ended()) reject(error);
        },
      )
      .finally(offCancel);
  });
}

export function createWorktree(
  project: Project,
  input: {
    worktreeName?: string;
    branchName?: string;
    base?: string;
    checkout?: boolean;
    // false has git write every tracked file instead of cloning them.
    cloneFiles?: boolean;
    // Leave the project's setup script out (carry-over and port
    // provision still run): a mirror or transplant told not to set
    // the copy up.
    skipSetup?: boolean;
  },
  notify: WorktreeOperationNotifiers,
  opts: { resolveOn?: "created" | "exit"; signal?: AbortSignal } = {},
): Promise<CreateWorktreeResult> {
  return runStreamingCreate(
    (reporter) =>
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
          },
          reporter,
        );
      }),
    project,
    undefined,
    notify,
    opts.resolveOn,
    opts.signal,
  );
}

// force only once the user has seen the changes the convert wipes.
// Unforced, adopt refuses a dirty worktree, untracked files included,
// with the convert refusal guardRefusal maps.
export function adoptWorktree(
  project: Project,
  worktreeId: string,
  force: boolean,
  notify: WorktreeOperationNotifiers,
): Promise<CreateWorktreeResult> {
  return runStreamingCreate(
    (reporter) =>
      Effect.gen(function* () {
        const located = yield* locate(project.id, worktreeId);
        return yield* (yield* Worktrees.Worktrees).adopt(
          located,
          { force },
          reporter,
        );
      }),
    project,
    worktreeId,
    notify,
  );
}

// A removal's account of a cleanup script that failed, which left the
// worktree in place.
type Removal =
  | { ok: true; cleanupError?: undefined }
  | { ok: false; cleanupError: CleanupError };

// A cancelled move's rollback puts the removal on a clock (timeoutMs).
export async function deleteWorktree(
  project: Project,
  input: { worktreeId: string; force?: boolean; skipCleanup?: boolean },
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
  opts: { timeoutMs?: number } = {},
): Promise<DeleteWorktreeResult> {
  const scripts = cliScriptStream(notify.notifyScript);
  const removal = Effect.gen(function* () {
    const located = yield* locate(project.id, input.worktreeId);
    return yield* (yield* Worktrees.Worktrees)
      .remove(
        located,
        {
          force: input.force === true,
          keepBranch: false,
          skipCleanup: input.skipCleanup === true,
        },
        scriptReporter(scripts),
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
  return change(
    opts.timeoutMs === undefined
      ? removal
      : removal.pipe(Effect.timeout(opts.timeoutMs)),
    { projectId: project.id, worktreeId: input.worktreeId },
  ).finally(scripts.end);
}

// The merged layers of a stack, removed together from the highest
// merged layer's worktree, which takes the worktrees of the merged
// layers under it too. The document lists them: the worktree itself
// under `removed`, the others under `stack.removed`, and on a cleanup
// failure whatever went before it.
export async function deleteStack(
  project: Project,
  input: { worktreeId: string; force?: boolean; skipCleanup?: boolean },
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
): Promise<DeleteStackResult> {
  const scripts = cliScriptStream(notify.notifyScript);
  const doc = await change(
    Effect.gen(function* () {
      const located = yield* locate(project.id, input.worktreeId);
      return yield* (yield* Landing.Landing).removeStack(
        located,
        {
          force: input.force === true,
          keepBranch: false,
          skipCleanup: input.skipCleanup === true,
        },
        scriptReporter(scripts),
      );
    }),
    { projectId: project.id, worktreeId: input.worktreeId },
  ).finally(scripts.end);
  const removed = removedIdsOf(doc);
  if (doc["ok"] === true) return { ok: true, removed };
  if (doc["cleanupError"] !== undefined) {
    return {
      ok: false,
      removed,
      cleanupError: decodeCleanupError(doc["cleanupError"]),
    };
  }
  throw new Error(
    typeof doc["error"] === "string" ? doc["error"] : "removing the stack failed",
  );
}

const RemovedIdSchema = Schema.Struct({ id: Schema.String });
const decodeLandDocRemovals = Schema.decodeUnknownSync(
  Schema.Struct({
    removed: Schema.optional(RemovedIdSchema),
    stack: Schema.optional(
      Schema.Struct({ removed: Schema.Array(RemovedIdSchema) }),
    ),
  }),
);

// The worktree ids a stack removal's document says went, the lower
// layers first and the worktree it ran from last, the order they were
// removed in.
function removedIdsOf(doc: Landing.Document): string[] {
  const parsed = decodeLandDocRemovals(doc);
  const ids = (parsed.stack?.removed ?? []).map((entry) => entry.id);
  if (parsed.removed) ids.push(parsed.removed.id);
  return ids;
}

// A removal that must happen (a nuke, the rollback of a failed or
// cancelled move): forced, so the port-pool lease is released and the
// teardown runs like any removal, and when that cleanup fails, again
// without it, since leaving the worktree behind is not an option. A
// cancelled move's rollback puts the cleanup on a clock too
// (opts.timeoutMs): the user is cancelling something that hung, and a
// teardown script that hangs the same way must not hold the cancel.
export async function forceRemoveWorktree(
  project: Project,
  worktreeId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const silent = { notifyScript: () => {} };
  // A run the clock stopped reads as a cleanup failure. A worktree that
  // is not there is not retried.
  const result = await deleteWorktree(
    project,
    { worktreeId, force: true },
    silent,
    opts,
  ).catch((error: unknown) => {
    if (isEntityGoneError(error)) throw error;
    return { ok: false as const };
  });
  if (!result.ok) {
    await deleteWorktree(
      project,
      { worktreeId, force: true, skipCleanup: true },
      silent,
    );
  }
}

// Forced: the app's cleanup box appears in merged-PR context, so the UI
// has already gated mergedness.
export async function finishWorktree(
  project: Project,
  worktreeId: string,
): Promise<Worktree> {
  const doc = await change(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      return yield* (yield* Landing.Landing).done(located, { force: true });
    }),
    { projectId: project.id, worktreeId },
  );
  return decodeWorktree(doc["worktree"]);
}

// `stack`: the PR and every open PR under it in its stack, which the
// engine resolves and merges bottom first.
export async function mergePullRequest(
  project: Project,
  number: number,
  method: MergeMethod,
  options: { stack?: boolean } = {},
): Promise<MergePullRequestResult> {
  const doc = await change(
    Effect.gen(function* () {
      const registered = yield* projectById(project.id);
      return yield* (yield* Landing.Landing).merge(
        { project: registered, number },
        { method, stack: options.stack === true },
        quiet,
      );
    }),
    { projectId: project.id },
  );
  return { outcome: mergeOutcomeOf(doc) };
}

const isMergeOutcome = Schema.is(MergeOutcomeSchema);

// The document spells the outcome the way MergeOutcomeSchema does. A
// document without one (a stack merge's) landed.
function mergeOutcomeOf(doc: Landing.Document): MergeOutcome {
  const outcome = doc["outcome"];
  return isMergeOutcome(outcome) ? outcome : "merged";
}

export async function setShelved(
  project: Project,
  worktreeId: string,
  shelved: boolean,
): Promise<void> {
  await change(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      yield* (yield* Worktrees.Worktrees).setShelved(
        located.worktree,
        shelved,
      );
    }),
    { projectId: project.id, worktreeId },
  );
}

export async function addProject(path: string): Promise<Project> {
  const project = await change(
    Effect.flatMap(Projects.Projects, (projects) => projects.add(path)),
  );
  // A registration is the one moment a path's identity may have
  // changed under the cache: a project removed and cloned again at the
  // same path within the TTL would otherwise read as the old one.
  forgetRepoIdentity(path);
  return Schema.decodeUnknownSync(ProjectSchema)(project);
}

// The command that runs a worktree's package.json script, and the
// SHIGOMORI_* values startScript can't derive, for the app's registry
// to spawn (it keeps owning streaming, cancel, and quit-time reaping).
// The engine picks the manager the lockfile selects and counts the run
// in the use log.
export async function packageScriptLaunch(args: {
  projectId: string;
  worktreeId: string;
  scriptName: string;
}): Promise<{ command: string; scriptEnv: ScriptEnvValues }> {
  return change(
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
}

// Whole-document config writes, the same write path the terminal's
// plumbing `write --data` verbs run (validation, the atomic merge, and
// the in-project exclude side effect for project config). The payloads
// were already parsed at the IPC boundary. The merge is NOT a plain
// overlay: for every REGISTERED key the payload omits it CLEARS that
// key (that is how a settings save serializes a default by omission),
// so only UNREGISTERED keys the payload does not carry survive
// untouched. A caller must therefore hand a COMPLETE base or a
// registered key it left out is written away. A null clears any key.
// Callers invalidate the TTL caches themselves.
//
// globalConfig carries device fields only, which the narrowed
// GlobalConfigSchema enforces at the IPC boundary. The keep-unregistered
// half of the merge is what keeps any legacy client keys (theme,
// doubutsu) intact when a device-only payload lands.
export async function writeGlobalConfig(
  config: ClearingWrite<GlobalConfig>,
): Promise<void> {
  await change(
    Effect.flatMap(EngineConfig.Config, (engineConfig) =>
      engineConfig.write({ kind: "device" }, config),
    ),
  );
}

// A config write payload where null clears the key.
export type ClearingWrite<T> = { -readonly [K in keyof T]?: T[K] | null };

// The renderer hands the whole project document and clears a field by
// leaving it out, so every field the schema models goes in the payload,
// nested objects field by field, as null where the document has none.
// Fields the schema doesn't model stay out, and the merge keeps them.
const PROJECT_KEY_PATHS = modeledKeyPaths(ShigomoriConfigSchema);
function withModeledFields(config: ShigomoriConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const path of PROJECT_KEY_PATHS) {
    let from: unknown = config;
    let into = payload;
    path.forEach((key, depth) => {
      from = (from as Record<string, unknown> | undefined)?.[key];
      if (depth === path.length - 1) into[key] = from ?? null;
      else into = (into[key] ??= {}) as Record<string, unknown>;
    });
  }
  return payload;
}

// A project's settings scope.
const projectScope = (projectId: string) =>
  Effect.map(projectById(projectId), (project) => ({
    kind: "project" as const,
    projectId: project.id,
    path: project.path,
  }));

export async function writeProjectConfig(
  projectId: string,
  config: ShigomoriConfig,
): Promise<void> {
  await change(
    Effect.gen(function* () {
      const scope = yield* projectScope(projectId);
      yield* (yield* EngineConfig.Config).write(
        scope,
        withModeledFields(config),
      );
    }),
    { projectId },
  );
}

// Registry removal and per-project state deletion only; the app-side
// extras (script reaping, icon cache) stay with the caller because
// those registries live in the app's process.
export async function removeProject(projectId: string): Promise<void> {
  await change(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      yield* (yield* Projects.Projects).remove(project);
    }),
    { projectId },
  );
}

// Repoints the registry entry at the moved repo and reconnects its
// worktrees, answering the project at its new path.
export async function relocateProject(
  projectId: string,
  path: string,
): Promise<Project> {
  const row = await change(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Worktrees.Worktrees).relocateProject(
        project,
        path,
      );
    }),
    { projectId },
  );
  const project = Schema.decodeUnknownSync(ProjectSchema)(row);
  // Like a registration, the identity cached for the path may be
  // another repo's that once sat there.
  forgetRepoIdentity(project.path);
  return project;
}

// ---- Worktree marks and moves ----

// A worktree's on/off mark, answered with the worktree's refreshed row.
async function setMark(
  set: (
    worktrees: Worktrees.Worktrees["Service"],
  ) => (
    worktree: Worktrees.WorktreeIdentity,
    on: boolean,
  ) => Effect.Effect<void, Worktrees.MarkRefused>,
  project: Project,
  worktreeId: string,
  on: boolean,
): Promise<Worktree> {
  const row = await change(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const located = yield* locate(project.id, worktreeId);
      yield* set(worktrees)(located.worktree, on);
      return yield* worktrees.row(located);
    }),
    { projectId: project.id, worktreeId },
  );
  return decodeWorktree(row);
}

// The auto-pull mark. The pull itself stays with the app's fetch sweep
// (host/lib/worktrees/autoPullSweep.ts).
export const setAutoPull = (
  project: Project,
  worktreeId: string,
  autoPull: boolean,
) =>
  setMark((worktrees) => worktrees.setAutoPull, project, worktreeId, autoPull);

export const setAgentWorking = (
  project: Project,
  worktreeId: string,
  agentWorking: boolean,
) =>
  setMark(
    (worktrees) => worktrees.setAgentWorking,
    project,
    worktreeId,
    agentWorking,
  );

// `git worktree move` plus the re-key of everything stored under the
// worktree's path-derived id (marks, its data, a pending dirty capture).
// The caller keeps the app-side guards around it (the tombstone, script
// reaping, mirror stop).
export async function moveWorktree(
  project: Project,
  worktreeId: string,
  destinationPath: string,
): Promise<Worktree> {
  const moved = await change(
    Effect.gen(function* () {
      const located = yield* locate(project.id, worktreeId);
      return yield* (yield* Worktrees.Worktrees).move(
        located,
        destinationPath,
      );
    }),
    { projectId: project.id, worktreeId },
  );
  return decodeWorktree(moved.worktree);
}

// The re-key half of a move, for the data folder move, which relocates
// the checkouts itself (one rename of the whole data dir). Answers
// with the id the worktree has at `toPath`.
export async function rekeyWorktree(
  projectId: string,
  fromId: string,
  toPath: string,
): Promise<string> {
  return change(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Worktrees.Worktrees).rekey(project, fromId, toPath);
    }),
    { projectId },
  );
}

export async function storeProjectOrder(ids: string[]): Promise<void> {
  await change(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      yield* registry.reorder(yield* registry.listed, ids);
    }),
  );
}

// ---- Reads ----

const decodeWorktrees = Schema.decodeUnknownSync(Schema.Array(WorktreeSchema));
const decodeWorktreeIdentities = Schema.decodeUnknownSync(
  Schema.Array(WorktreeIdentitySchema),
);

// A project's rows, primary first: the sidebar's list. A project whose
// checkouts git can't list reads as having none, as the terminal's
// listing skips it.
export async function listWorktrees(
  projectId: string,
): Promise<readonly Worktree[]> {
  const listing = await call(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Worktrees.Worktrees).list([project]);
    }),
    { projectId },
  );
  return decodeWorktrees(listing.rows);
}

// One row, freshly probed: what a mutation hands back to the renderer.
export async function describeWorktree(
  projectId: string,
  worktreeId: string,
): Promise<Worktree> {
  const row = await call(
    Effect.gen(function* () {
      const located = yield* locate(projectId, worktreeId);
      return yield* (yield* Worktrees.Worktrees).row(located, {
        settle: true,
      });
    }),
    { projectId, worktreeId },
  );
  return decodeWorktree(row);
}

// Identities without git probes (see WorktreeIdentitySchema): a
// project's (or, with no projectId, every project's), or the one
// `worktreeId` names. `primaryRef` adds the project's primary ref.
export async function listWorktreeIdentities(
  scope: { projectId?: string; worktreeId?: string },
  opts: { primaryRef?: boolean } = {},
): Promise<readonly WorktreeIdentity[]> {
  const options = { primaryRef: opts.primaryRef === true };
  const rows = await call(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const at = yield* worktrees.here("/");
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
}

const decodeProjectRows = Schema.decodeUnknownSync(
  Schema.Array(ProjectRowSchema),
);
const decodeProjectIcon = Schema.decodeUnknownSync(
  Schema.NullOr(ProjectIconSchema),
);

// Every registered project, terrier's merged in, decorated for the
// sidebar. `refreshIcons` re-scans projects the icon cache remembers
// as icon-less (the first list of a session).
export async function listProjects(
  opts: { refreshIcons?: boolean } = {},
): Promise<readonly ProjectRow[]> {
  const rows = await call(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.rows({ rescanIconMisses: opts.refreshIcons === true }),
    ),
  );
  return decodeProjectRows(rows);
}

// The icon's bytes, or null. A remembered miss is scanned again: the
// renderer asks once per project per session, and an icon added since
// the miss was cached must show.
export async function projectIcon(
  projectId: string,
): Promise<ProjectIcon | null> {
  const icon = await call(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Icons.Icons).bytes(project.path, {
        rescanMisses: true,
      });
    }),
    { projectId },
  );
  return decodeProjectIcon(Option.getOrNull(icon));
}

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
export async function worktreeDestination(
  projectId: string,
  name?: string,
): Promise<{ name: string; path: string; taken: boolean }> {
  const destination = await call(
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
}

const decodeGlobalConfig = Schema.decodeUnknownSync(StoredGlobalConfigSchema);

// The device's settings as stored: unknown keys kept, no defaults
// filled in (callers apply their own, as they always have).
export async function readGlobalConfig(): Promise<GlobalConfig> {
  const stored = await call(
    Effect.flatMap(EngineConfig.Config, (engineConfig) =>
      engineConfig.read({ kind: "device" }),
    ),
  );
  return decodeGlobalConfig(stored ?? {});
}

const decodeProjectConfig = Schema.decodeUnknownSync(
  Schema.NullOr(StoredShigomoriConfigSchema),
);

// The project's settings as stored, or null when it has none.
export async function readProjectConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  const stored = await call(
    Effect.gen(function* () {
      const scope = yield* projectScope(projectId);
      return yield* (yield* EngineConfig.Config).read(scope);
    }),
    { projectId },
  );
  return decodeProjectConfig(stored);
}

const decodeDiskUsage = Schema.decodeUnknownSync(
  WorktreeDiskUsageSchema.mapFields(Struct.omit(["worktreeId"])),
);

// One directory's disk footprint and what removing it would free,
// stepping over the `exclude` directories (nested worktrees, measured as
// rows of their own). Unreadable entries come back as `partial`.
export async function diskUsage(
  path: string,
  exclude: string[],
): Promise<Omit<WorktreeDiskUsage, "worktreeId">> {
  const usage = await call(
    Effect.flatMap(Hygiene.Hygiene, (hygiene) =>
      hygiene.measure(path, exclude),
    ),
  );
  return decodeDiskUsage(usage);
}

const decodeLauncherRow = Schema.decodeUnknownSync(
  Schema.Struct({
    entries: Schema.Array(LauncherEntrySchema),
    hiddenCount: Schema.Natural,
  }),
);

// The project's launcher row: installed tools, the GitHub entry and
// custom commands, hidden ones left out, most used first.
export async function launcherRow(projectId: string): Promise<{
  readonly entries: readonly LauncherEntry[];
  readonly hiddenCount: number;
}> {
  const row = await call(
    Effect.gen(function* () {
      const project = yield* projectById(projectId);
      return yield* (yield* Launchers.Launchers).row(project);
    }),
    { projectId },
  );
  return decodeLauncherRow(row);
}

const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Array(DetectedLauncherSchema),
);

// Every tool the catalog knows, installed or not, by label.
export async function launcherCatalog(): Promise<readonly DetectedLauncher[]> {
  const apps = await call(
    Effect.flatMap(Launchers.Launchers, (launchers) => launchers.catalog),
  );
  return decodeCatalog(apps);
}

const decodePackageScripts = Schema.decodeUnknownSync(PackageScriptsDocSchema);

// The worktree's package.json scripts, or null when it has no readable
// package.json. A worktree or project that is gone still fails.
export async function packageScripts(
  projectId: string,
  worktreeId: string,
): Promise<PackageScriptsDoc | null> {
  const listed = await call(
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
            NoPackageJson: () => Effect.succeed(null),
            UnreadablePackageJson: () => Effect.succeed(null),
          }),
        );
    }),
    { projectId, worktreeId },
  );
  return listed === null ? null : decodePackageScripts(listed);
}

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
export async function runDoctor(
  fix: boolean,
  input: { version: string; executable: string; zdotdir?: string },
): Promise<DoctorReport> {
  const doctor =
    input.zdotdir === undefined
      ? Effect.service(Doctor.Doctor)
      : Effect.provide(
          Effect.service(Doctor.Doctor),
          Doctor.layer.pipe(
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
  const report = await (fix ? change(run) : call(run));
  return decodeDoctorReport(report);
}
