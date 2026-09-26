// The app's one door to the bundled CLI, which owns the data model:
// every worktree and project mutation (create, adopt, delete, done,
// merge, move, the shelf and auto-pull marks, project add, remove and
// reorder) and every read of what the CLI owns (worktree rows and
// identities, the project list and icons, the stored config, the
// launcher row, package scripts) runs `sm --json ...` here, so the app
// and a terminal run the exact same engine and nothing drifts. Each
// function translates the CLI's NDJSON into the shapes the IPC
// handlers already serve. Every document crossing the Go/TS boundary
// is validated against the shared zod schemas, so drift fails loudly
// here instead of surfacing as undefined-flavored breakage in the
// renderer.
import { z } from "zod";
import {
  CarryOverReportSchema,
  CleanupErrorSchema,
  CommitHashSchema,
  CreatePhaseSchema,
  type CleanupError,
  type CreateWorktreeResult,
  type DeleteStackResult,
  type DeleteWorktreeResult,
  type DetectedLauncher,
  DetectedLauncherSchema,
  type GlobalConfig,
  LauncherEntrySchema,
  type LauncherEntry,
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
  StoredGlobalConfigSchema,
  StoredShigomoriConfigSchema,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeIdentity,
  WorktreeIdentitySchema,
  type WorktreeLifecyclePhase,
  WorktreeSchema,
} from "@shared/schemas";
import {
  isEntityGoneError,
  unknownProjectError,
  unknownWorktreeError,
} from "@shared/errors";
import { forgetRepoIdentity } from "@host/lib/git/repoIdentity";
import { shellQuote } from "@host/lib/scripts/process";
import { implSlot } from "@host/lib/util/implSlot";

// One NDJSON document from the CLI's --json stream. `event` is set on
// streamed progress documents (created/phase/carryOver/script/done);
// single-document commands (rm, done, merge) emit result objects
// without it.
export interface CliDoc {
  event?: string;
  [key: string]: unknown;
}

export interface CliResult {
  code: number;
  docs: CliDoc[];
  stderrTail: string;
}

// The electron layer injects the CLI process runner at boot. Spawning
// stays in main/electron (the runner resolves the binary through
// Electron's packaging paths and registers children with quit-time
// reaping), so this seam owns the document shapes and the delegate
// stays free of Electron imports.
type CliRunnerImpl = {
  runCli: (
    args: string[],
    onDoc?: (doc: CliDoc) => void,
    extraEnv?: Record<string, string>,
    opts?: { background?: boolean; readOnly?: boolean; timeoutMs?: number },
  ) => Promise<CliResult>;
  requireCliBinary: () => string;
  cliFailureMessage: (result: CliResult, fallback: string) => string;
};

const { set: setCliRunnerImpl, get: runner } = implSlot<CliRunnerImpl>(
  "cli delegate invoked before setCliRunnerImpl registered one",
);
export { setCliRunnerImpl };

// Renderer-bound emit callbacks supplied by the IPC handler, fed from
// the CLI's streamed lifecycle documents.
interface WorktreeOperationNotifiers {
  notifyPhase: (payload: WorktreeLifecyclePhase) => void;
  notifyCarryOverComplete: (payload: WorktreeCarryOverComplete) => void;
  notifyScript: (payload: ScriptEvent) => void;
}

// A streamed "script" document, forwarded as the script event it
// carries (the event tag itself is the stream's, not the payload's).
function notifyScriptDoc(
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
  doc: CliDoc,
): void {
  const { event: _event, ...scriptEvent } = doc;
  notify.notifyScript(ScriptEventSchema.parse(scriptEvent));
}

// The argv of a verb that acts on one worktree of one project.
function worktreeArgv(
  verb: string[],
  project: Project,
  worktreeId: string,
): string[] {
  return [...verb, "--project-id", project.id, "--worktree-id", worktreeId];
}

const PhaseSchema = z.union([CreatePhaseSchema, z.literal("idle")]);

// The failure for a run that produced no ok result. The CLI's --json
// error document carries a stable `code` for entity-gone failures;
// mapping it onto the shared constructors here means the renderer's
// matcher keys on the code, not on the CLI's prose.
function cliFailure(
  result: CliResult,
  fallback: string,
  ids: { projectId?: string; worktreeId?: string } = {},
): Error {
  const code = result.docs.find(isErrorDoc)?.["code"];
  if (code === "unknown-project" && ids.projectId !== undefined) {
    return unknownProjectError(ids.projectId);
  }
  if (code === "unknown-worktree" && ids.worktreeId !== undefined) {
    return unknownWorktreeError(ids.worktreeId);
  }
  return new Error(runner().cliFailureMessage(result, fallback));
}

// A read's document can be an array or null, not only an object.
function isErrorDoc(doc: unknown): doc is CliDoc {
  return (
    typeof doc === "object" &&
    doc !== null &&
    (doc as Record<string, unknown>)["ok"] === false
  );
}

// The final {ok: boolean} document of a run; throws the mapped failure
// when the run never produced a successful result.
function finalOkDoc(
  result: CliResult,
  fallback: string,
  ids: { projectId?: string; worktreeId?: string } = {},
): CliDoc {
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] !== true) throw cliFailure(result, fallback, ids);
  return final;
}

// Streamed create/adopt: resolve the IPC promise on the "created"
// document (the app navigates immediately) and keep forwarding
// lifecycle events to the renderer until the process exits.
// resolveOn "exit" waits out the WHOLE run instead (carry-over and
// setup included) for callers that sequence more work after the
// create, like the pull orchestration's dirty apply; a post-created
// setup failure still resolves, matching the early-resolve semantics
// where such failures only surface as lifecycle events.
function runStreamingCreate(
  args: string[],
  project: Project,
  worktreeId: string | undefined,
  notify: WorktreeOperationNotifiers,
  failureLabel: string,
  resolveOn: "created" | "exit" = "created",
): Promise<CreateWorktreeResult> {
  return new Promise((resolve, reject) => {
    let created: Worktree | null = null;
    const onDoc = (doc: CliDoc) => {
      switch (doc.event) {
        case "created": {
          created = WorktreeSchema.parse(doc["worktree"]);
          if (resolveOn === "created") resolve({ worktree: created });
          break;
        }
        case "phase": {
          if (!created) break;
          notify.notifyPhase({
            projectId: project.id,
            worktreeId: created.id,
            phase: PhaseSchema.parse(doc["phase"]),
          });
          break;
        }
        case "carryOver": {
          if (!created) break;
          notify.notifyCarryOverComplete({
            projectId: project.id,
            worktreeId: created.id,
            report: CarryOverReportSchema.parse(doc["report"]),
          });
          break;
        }
        case "script":
          notifyScriptDoc(notify, doc);
          break;
      }
    };
    runner()
      .runCli(args, (doc) => {
        // A schema mismatch before "created" fails the whole call; after
        // it the promise is already resolved, so surface it as a log
        // instead of losing it inside the stream reader.
        try {
          onDoc(doc);
        } catch (error) {
          if (created === null) reject(error as Error);
          else
            console.warn("[cli] mid-stream document failed validation", error);
        }
      })
      .then((result) => {
        if (created === null) {
          reject(cliFailure(result, failureLabel, { worktreeId }));
        } else if (resolveOn === "exit") {
          resolve({ worktree: created });
        }
      }, reject);
  });
}

export function createViaCli(
  project: Project,
  input: {
    worktreeName?: string;
    branchName?: string;
    base?: string;
    checkout?: boolean;
    // Leave the project's setup script out (carry-over and port
    // provision still run): a mirror or transplant told not to set
    // the copy up.
    skipSetup?: boolean;
  },
  notify: WorktreeOperationNotifiers,
  opts: { resolveOn?: "created" | "exit" } = {},
): Promise<CreateWorktreeResult> {
  const args = ["create", "--project-id", project.id];
  if (input.branchName) args.push("--branch", input.branchName);
  if (input.base) args.push("--base", input.base);
  if (input.checkout) args.push("--checkout");
  if (input.skipSetup) args.push("--no-setup");
  // End-of-options terminator before the caller-influenced worktree name
  // so a flag-shaped name can never be read as an option. Pushed last,
  // after every flag, because `--` makes the parser treat the rest as
  // positionals. Matches the `--`-pinned argv convention the git guards
  // and cliRunScriptSpawn use.
  if (input.worktreeName) args.push("--", input.worktreeName);
  return runStreamingCreate(
    args,
    project,
    undefined,
    notify,
    "sm create failed",
    opts.resolveOn,
  );
}

export function adoptViaCli(
  project: Project,
  worktreeId: string,
  notify: WorktreeOperationNotifiers,
): Promise<CreateWorktreeResult> {
  // --force: the app's convert flow already confirmed the wipe in its
  // dialog.
  return runStreamingCreate(
    [...worktreeArgv(["adopt"], project, worktreeId), "--force"],
    project,
    worktreeId,
    notify,
    "sm adopt failed",
  );
}

export async function deleteViaCli(
  project: Project,
  input: { worktreeId: string; force?: boolean; skipCleanup?: boolean },
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
): Promise<DeleteWorktreeResult> {
  const args = worktreeArgv(["rm"], project, input.worktreeId);
  if (input.force) args.push("--force");
  if (input.skipCleanup) args.push("--skip-cleanup");
  const { ok, cleanupError } = await runRemoval(args, input.worktreeId, notify);
  return ok ? { ok } : { ok, cleanupError };
}

// The merged layers of a stack, removed together: `sm rm --stack` on
// the highest merged layer's worktree, which takes the worktrees of
// the merged layers under it too (cli/cmd_land.go rmStack). The final
// document lists them: the worktree itself under `removed`, the
// others under `stack.removed`, and on a cleanup failure whatever
// went before it.
export async function deleteStackViaCli(
  project: Project,
  input: { worktreeId: string; force?: boolean },
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
): Promise<DeleteStackResult> {
  const args = [...worktreeArgv(["rm"], project, input.worktreeId), "--stack"];
  if (input.force) args.push("--force");
  const { ok, cleanupError, final } = await runRemoval(
    args,
    input.worktreeId,
    notify,
  );
  const removed = removedIdsOf(final);
  return ok ? { ok, removed } : { ok, removed, cleanupError };
}

// One removal run: the script events forwarded, the final document
// read for its verdict. A run that ends without one, or without the
// cleanup error a failed one carries, is the CLI's failure.
async function runRemoval(
  args: string[],
  worktreeId: string,
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
): Promise<
  | { ok: true; cleanupError?: undefined; final: CliDoc }
  | { ok: false; cleanupError: CleanupError; final: CliDoc }
> {
  const result = await runner().runCli(args, (doc) => {
    if (doc.event === "script") notifyScriptDoc(notify, doc);
  });
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] === true) return { ok: true, final };
  if (final?.["ok"] === false && final["cleanupError"] !== undefined) {
    return {
      ok: false,
      cleanupError: CleanupErrorSchema.parse(final["cleanupError"]),
      final,
    };
  }
  throw cliFailure(result, `sm ${args[0]} failed`, { worktreeId });
}

const RemovedIdSchema = z.object({ id: z.string() });
const LandDocRemovalsSchema = z.object({
  removed: RemovedIdSchema.optional(),
  stack: z.object({ removed: z.array(RemovedIdSchema) }).optional(),
});

// The worktree ids a stack removal's document says went, the lower
// layers first and the worktree the command ran in last, the order the
// CLI removed them.
function removedIdsOf(doc: CliDoc): string[] {
  const parsed = LandDocRemovalsSchema.parse(doc);
  const ids = (parsed.stack?.removed ?? []).map((entry) => entry.id);
  if (parsed.removed) ids.push(parsed.removed.id);
  return ids;
}

// A removal that must happen (a nuke, the rollback of a failed mirror
// start): `sm rm --force`, so the port-pool lease is released and the
// teardown runs like any removal, and when that cleanup fails, again
// without it, since leaving the worktree behind is not an option.
export async function forceRemoveViaCli(
  project: Project,
  worktreeId: string,
): Promise<void> {
  const quiet = { notifyScript: () => {} };
  const result = await deleteViaCli(
    project,
    { worktreeId, force: true },
    quiet,
  );
  if (!result.ok) {
    await deleteViaCli(
      project,
      { worktreeId, force: true, skipCleanup: true },
      quiet,
    );
  }
}

export async function doneViaCli(
  project: Project,
  worktreeId: string,
): Promise<Worktree> {
  // --force: the app's cleanup box appears in merged-PR context, so the
  // UI has already gated mergedness.
  const result = await runner().runCli([
    ...worktreeArgv(["done"], project, worktreeId),
    "--force",
  ]);
  const final = finalOkDoc(result, "sm done failed", { worktreeId });
  return WorktreeSchema.parse(final["worktree"]);
}

// `stack`: the PR and every open PR under it in its stack, which the
// CLI resolves and merges bottom first (cli/stack.go).
export async function mergeViaCli(
  project: Project,
  number: number,
  method: string,
  options: { stack?: boolean } = {},
): Promise<void> {
  const args = [
    "merge",
    "--project-id",
    project.id,
    "--number",
    String(number),
    "--method",
    method,
  ];
  if (options.stack) args.push("--stack");
  const result = await runner().runCli(args);
  finalOkDoc(result, "sm merge failed", { projectId: project.id });
}

export async function setShelvedViaCli(
  project: Project,
  worktreeId: string,
  shelved: boolean,
): Promise<void> {
  const result = await runner().runCli(
    worktreeArgv([shelved ? "shelve" : "unshelve"], project, worktreeId),
  );
  finalOkDoc(result, "sm shelve failed", { worktreeId });
}

export async function projectsAddViaCli(path: string): Promise<Project> {
  // End-of-options terminator before the caller-influenced path so a
  // flag-shaped path (`--all`, `--yes`) can never be read as an option:
  // PathPayloadSchema puts no constraint on the string, so this guard is
  // what neutralizes it rather than luck. Matches the `--`-pinned argv
  // convention the git guards use.
  const result = await runner().runCli(["projects", "add", "--", path]);
  const doc = result.docs.findLast(
    (d) => typeof d["id"] === "string" && typeof d["path"] === "string",
  );
  if (result.code !== 0 || doc === undefined) {
    throw cliFailure(result, "sm projects add failed");
  }
  // A registration is the one moment a path's identity may have
  // changed under the cache: a project removed and cloned again at the
  // same path within the TTL would otherwise read as the old one.
  forgetRepoIdentity(path);
  return ProjectSchema.parse(doc);
}

// The command that runs a package.json script through the CLI
// engine. Unlike the functions above this doesn't spawn anything:
// package-script runs go through startScript so the app's registry
// keeps owning streaming, cancel, and quit-time reaping. The CLI
// contributes everything else: the manager the lockfile selects, the
// SHIGOMORI_* env, and the use-log bump (an external state.json write
// the caller covers with a self-write note, see packageScripts.run).
// `--` guards a script name that looks like a flag.
export function cliRunScriptSpawn(args: {
  projectId: string;
  worktreeId: string;
  scriptName: string;
}): string {
  const binary = runner().requireCliBinary();
  return [
    shellQuote(binary),
    "run",
    "--project-id",
    shellQuote(args.projectId),
    "--worktree-id",
    shellQuote(args.worktreeId),
    "--",
    shellQuote(args.scriptName),
  ].join(" ");
}

// Whole-document config writes through the CLI's plumbing `write
// --data` verbs, so both surfaces run one write path (validation,
// lock+atomic merge, and the in-project exclude side effect for
// project config). The payloads were already zod-parsed at the
// IPC boundary. The CLI's merge is NOT a plain overlay: for every
// REGISTERED key the payload omits it CLEARS that key on disk (that is
// how a settings save serializes a default by omission), so only
// UNREGISTERED keys the payload does not carry survive untouched. A
// caller must therefore hand a COMPLETE base or a registered key it
// left out is written away. It re-checks the shape so engine drift fails loudly.
// Callers must invalidate the TTL caches themselves: runCli's self-write
// note suppresses the state watcher for these writes.
//
// globalConfig carries device fields only, which the narrowed
// GlobalConfigSchema enforces at the IPC boundary. The keep-unregistered
// half of the merge is what keeps any legacy client keys (theme,
// doubutsu) in config.json intact when a device-only payload lands.
export async function globalConfigWriteViaCli(
  config: GlobalConfig,
): Promise<void> {
  const result = await runner().runCli([
    "config",
    "write",
    "--data",
    JSON.stringify(config),
  ]);
  finalOkDoc(result, "sm config write failed");
}

export async function shigomoriWriteViaCli(
  projectId: string,
  config: ShigomoriConfig,
): Promise<void> {
  const result = await runner().runCli([
    "projects",
    "config",
    "write",
    "--project-id",
    projectId,
    "--data",
    JSON.stringify(config),
  ]);
  finalOkDoc(result, "sm projects config write failed", { projectId });
}

// The device-sync verbs. Each shells the CLI and
// re-validates the crossing document with a zod schema, like every
// other Go/TS boundary in this file. The paths handed to bundle
// create/unpack are ALWAYS app-chosen temp paths (the source link,
// host/lib/sync/sourceLink.ts, owns them); the CLI writes/reads exactly where told,
// so path discipline lives on this side of the trust boundary.

export async function dirtyCaptureViaCli(
  project: Project,
  worktreeId: string,
): Promise<{ captured: boolean; commit?: string }> {
  const result = await runner().runCli(
    worktreeArgv(["dirty", "capture"], project, worktreeId),
  );
  const final = finalOkDoc(result, "sm dirty capture failed", { worktreeId });
  // A capture doc carries its commit; a clean worktree omits it. The
  // refine makes a captured:true document WITHOUT a commit an engine
  // drift error here, never a silent "clean" report.
  const doc = z
    .object({ captured: z.boolean(), commit: z.string().optional() })
    .refine((d) => !d.captured || d.commit !== undefined, {
      message: "captured without a commit",
    })
    .parse(final);
  return doc.captured
    ? { captured: true, commit: doc.commit }
    : { captured: false };
}

// Mirrors dirtyCaptureViaCli: replays refs/shigomori/dirty/<id> onto
// the worktree and consumes the ref (`sm dirty apply`, cli/cmd_dirty.go).
// The CLI's own guards (HEAD must be the capture's parent, tree clean,
// no added-path collisions) are the failure surface here.
export async function dirtyApplyViaCli(
  project: Project,
  worktreeId: string,
): Promise<{ applied: boolean; commit: string; changedFiles: number }> {
  const result = await runner().runCli(
    worktreeArgv(["dirty", "apply"], project, worktreeId),
  );
  const final = finalOkDoc(result, "sm dirty apply failed", { worktreeId });
  return z
    .object({
      applied: z.literal(true),
      commit: CommitHashSchema,
      changedFiles: z.number().int().nonnegative(),
    })
    .parse(final);
}

const RefTipDocSchema = z.object({ ref: z.string(), commit: CommitHashSchema });

export async function bundleCreateViaCli(
  project: Project,
  outPath: string,
  refs: string[],
  haves: string[],
): Promise<{ bytes: number; refs: { ref: string; commit: string }[] }> {
  const result = await runner().runCli([
    "bundle",
    "create",
    "--project-id",
    project.id,
    "--out",
    outPath,
    ...refs.flatMap((ref) => ["--ref", ref]),
    ...haves.flatMap((have) => ["--have", have]),
  ]);
  const final = finalOkDoc(result, "sm bundle create failed", {
    projectId: project.id,
  });
  return z
    .object({
      bytes: z.number().int().nonnegative(),
      refs: z.array(RefTipDocSchema),
    })
    .parse(final);
}

// Into a registered project, or into a repository by path: the clone
// from a peer (host/lib/sync/cloneFromPeer.ts) unpacks into a folder
// it registers only once it is a checkout.
export async function bundleUnpackViaCli(
  target: Project | { path: string },
  inPath: string,
  refspecs: string[],
): Promise<{ fetched: { ref: string; commit: string }[] }> {
  const project = "id" in target ? target : undefined;
  const result = await runner().runCli([
    "bundle",
    "unpack",
    ...(project ? ["--project-id", project.id] : ["--repo", target.path]),
    "--in",
    inPath,
    ...refspecs.flatMap((spec) => ["--refspec", spec]),
  ]);
  const final = finalOkDoc(result, "sm bundle unpack failed", {
    projectId: project?.id,
  });
  return z.object({ fetched: z.array(RefTipDocSchema) }).parse(final);
}

// Registry removal and per-project state deletion only; the app-side
// extras (script reaping, icon cache) stay with the caller because
// those registries live in the app's process.
export async function projectsRemoveViaCli(projectId: string): Promise<void> {
  const result = await runner().runCli([
    "projects",
    "remove",
    "--project-id",
    projectId,
    "--yes",
  ]);
  finalOkDoc(result, "sm projects remove failed", { projectId });
}

// ---- Worktree marks and moves ----

// The auto-pull mark (`sm worktrees autopull`), answered with the
// worktree's refreshed row. The pull itself stays with the app's fetch
// sweep (host/lib/worktrees/autoPullSweep.ts).
export async function setAutoPullViaCli(
  project: Project,
  worktreeId: string,
  autoPull: boolean,
): Promise<Worktree> {
  const result = await runner().runCli(
    worktreeArgv(
      ["worktrees", "autopull", autoPull ? "on" : "off"],
      project,
      worktreeId,
    ),
  );
  const final = finalOkDoc(result, "sm worktrees autopull failed", {
    worktreeId,
  });
  return WorktreeSchema.parse(final["worktree"]);
}

// `git worktree move` plus the re-key of everything stored under the
// worktree's path-derived id (marks, notes, a pending dirty capture).
// The caller keeps the app-side guards around it (the tombstone, script
// reaping, mirror stop).
export async function moveViaCli(
  project: Project,
  worktreeId: string,
  destinationPath: string,
): Promise<Worktree> {
  const result = await runner().runCli([
    ...worktreeArgv(["worktrees", "move"], project, worktreeId),
    "--",
    destinationPath,
  ]);
  const final = finalOkDoc(result, "sm worktrees move failed", {
    worktreeId,
  });
  return WorktreeSchema.parse(final["worktree"]);
}

// The re-key half of a move, for the data folder move, which relocates
// the checkouts itself (one rename of the whole data dir). Answers
// with the id the worktree has at `toPath`.
export async function rekeyViaCli(
  projectId: string,
  fromId: string,
  toPath: string,
): Promise<string> {
  const result = await runner().runCli([
    "worktrees",
    "rekey",
    "--project-id",
    projectId,
    "--from-id",
    fromId,
    "--to-path",
    toPath,
  ]);
  const final = finalOkDoc(result, "sm worktrees rekey failed", { projectId });
  return z.object({ id: z.string() }).parse(final).id;
}

export async function reorderProjectsViaCli(ids: string[]): Promise<void> {
  const result = await runner().runCli([
    "projects",
    "reorder",
    "--ids",
    ids.join(","),
  ]);
  finalOkDoc(result, "sm projects reorder failed");
}

// Launches a launcher-row entry (`app:…`, `custom:…`, `web:github`) in
// the worktree through `sm open`, which also counts the use.
export async function openLauncherViaCli(
  project: Project,
  worktreeId: string,
  launcherId: string,
): Promise<void> {
  const result = await runner().runCli([
    ...worktreeArgv(["open"], project, worktreeId),
    "--",
    launcherId,
  ]);
  finalOkDoc(result, "sm open failed", { worktreeId });
}

// ---- Reads ----

// One read: the CLI spawned as a reader (runCli's readOnly, so it
// neither counts as work in flight nor mutes the state watcher) and
// the one document it prints, or the mapped failure.
async function readDoc(
  args: string[],
  fallback: string,
  ids: { projectId?: string; worktreeId?: string } = {},
): Promise<unknown> {
  const result = await runner().runCli(args, undefined, undefined, {
    readOnly: true,
  });
  const doc: unknown = result.docs.at(-1);
  if (result.code !== 0 || doc === undefined || isErrorDoc(doc)) {
    throw cliFailure(result, fallback, ids);
  }
  return doc;
}

// A project's rows, primary first: the sidebar's list, one spawn per
// project per refresh.
export async function listWorktreesViaCli(
  projectId: string,
): Promise<Worktree[]> {
  const doc = await readDoc(
    ["worktrees", "list", "--project-id", projectId],
    "sm worktrees list failed",
    { projectId },
  );
  return z.array(WorktreeSchema).parse(doc);
}

// One row, freshly probed: what a mutation hands back to the renderer.
export async function describeWorktreeViaCli(
  projectId: string,
  worktreeId: string,
): Promise<Worktree> {
  const doc = await readDoc(
    [
      "worktrees",
      "list",
      "--project-id",
      projectId,
      "--worktree-id",
      worktreeId,
    ],
    "sm worktrees list failed",
    { projectId, worktreeId },
  );
  return z.array(WorktreeSchema).length(1).parse(doc)[0];
}

// Identities without git probes (see WorktreeIdentitySchema): a
// project's (or, with no projectId, every project's), or the one
// `worktreeId` names. `primaryRef` adds the project's primary ref.
export async function listWorktreeIdentitiesViaCli(
  scope: { projectId?: string; worktreeId?: string },
  opts: { primaryRef?: boolean } = {},
): Promise<WorktreeIdentity[]> {
  const args = ["worktrees", "list", "--identities"];
  if (scope.projectId === undefined) args.push("--all");
  else args.push("--project-id", scope.projectId);
  if (scope.worktreeId !== undefined) {
    args.push("--worktree-id", scope.worktreeId);
  }
  if (opts.primaryRef) args.push("--primary-ref");
  const doc = await readDoc(args, "sm worktrees list failed", scope);
  return z.array(WorktreeIdentitySchema).parse(doc);
}

// Every registered project, terrier's merged in, decorated for the
// sidebar. `refreshIcons` re-scans projects the icon cache remembers
// as icon-less (the first list of a session).
export async function listProjectsViaCli(
  opts: { refreshIcons?: boolean } = {},
): Promise<ProjectRow[]> {
  const args = ["projects", "list"];
  if (opts.refreshIcons) args.push("--refresh-icons");
  const doc = await readDoc(args, "sm projects list failed");
  return z.array(ProjectRowSchema).parse(doc);
}

// The icon's bytes, or null. --refresh-icons re-scans a remembered
// miss: the renderer asks once per project per session, and an icon
// added since the miss was cached must show.
export async function projectIconViaCli(
  projectId: string,
): Promise<ProjectIcon | null> {
  const doc = await readDoc(
    ["projects", "icon", "--project-id", projectId, "--refresh-icons"],
    "sm projects icon failed",
    { projectId },
  );
  return ProjectIconSchema.nullable().parse(doc);
}

// Where a new worktree would land, and under what name: `name` when
// given (then `taken` says whether a worktree already holds the name
// or something the path), else a freshly picked free one.
export async function worktreeDestinationViaCli(
  projectId: string,
  name?: string,
): Promise<{ name: string; path: string; taken: boolean }> {
  const args = ["worktrees", "destination", "--project-id", projectId];
  if (name !== undefined) args.push("--name", name);
  const doc = await readDoc(args, "sm worktrees destination failed", {
    projectId,
  });
  return z
    .object({ name: z.string(), path: z.string(), taken: z.boolean() })
    .parse(doc);
}

// config.json as stored: unknown keys kept, no defaults filled in
// (callers apply their own, as they always have).
export async function globalConfigReadViaCli(): Promise<GlobalConfig> {
  const doc = await readDoc(["config", "read"], "sm config read failed");
  return z.object({ config: StoredGlobalConfigSchema }).parse(doc).config;
}

// project.json as stored, or null when the project has none.
export async function shigomoriReadViaCli(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  const doc = await readDoc(
    ["projects", "config", "read", "--project-id", projectId],
    "sm projects config read failed",
    { projectId },
  );
  if (doc === null) return null;
  return z.object({ config: StoredShigomoriConfigSchema.nullable() }).parse(doc)
    .config;
}

// The project's launcher row: installed tools, the GitHub entry and
// custom commands, hidden ones left out, most used first.
export async function launchersViaCli(
  projectId: string,
): Promise<{ entries: LauncherEntry[]; hiddenCount: number }> {
  const doc = await readDoc(
    ["launchers", "--project-id", projectId],
    "sm launchers failed",
    { projectId },
  );
  return z
    .object({
      entries: z.array(LauncherEntrySchema),
      hiddenCount: z.number().int().nonnegative(),
    })
    .parse(doc);
}

// Every tool the catalog knows, installed or not, by label.
export async function launcherCatalogViaCli(): Promise<DetectedLauncher[]> {
  const doc = await readDoc(["launchers", "--catalog"], "sm launchers failed");
  return z.object({ apps: z.array(DetectedLauncherSchema) }).parse(doc).apps;
}

// The worktree's package.json scripts (`sm run` with no script), or
// null when it has no readable package.json. A worktree or project
// that is gone still fails.
export async function packageScriptsViaCli(
  projectId: string,
  worktreeId: string,
): Promise<PackageScriptsDoc | null> {
  let doc: unknown;
  try {
    doc = await readDoc(
      ["run", "--project-id", projectId, "--worktree-id", worktreeId],
      "sm run failed",
      { projectId, worktreeId },
    );
  } catch (error) {
    // Missing and unparseable read the same: no scripts to offer.
    if (isEntityGoneError(error)) throw error;
    return null;
  }
  return PackageScriptsDocSchema.parse(doc);
}
