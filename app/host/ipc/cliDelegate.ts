// Routes the app's state mutations through the bundled CLI so the app
// and a terminal run the exact same engine (the user's core
// requirement: deterministic behavior across surfaces): worktree
// create/adopt/delete/done/merge, the shelved flag, and project
// add/remove. Each function translates the CLI's NDJSON stream into
// the notifier calls the renderer already understands. Every document
// crossing the Go/TS boundary is validated against the shared zod
// schemas, so drift fails loudly here instead of surfacing as
// undefined-flavored breakage in the renderer.
import { z } from "zod";
import {
  CarryOverReportSchema,
  CleanupErrorSchema,
  CommitHashSchema,
  CreatePhaseSchema,
  type CreateWorktreeResult,
  type DeleteWorktreeResult,
  type GlobalConfig,
  type Project,
  ProjectSchema,
  type ScriptEvent,
  ScriptEventSchema,
  type ShigomoriConfig,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeLifecyclePhase,
  WorktreeSchema,
} from "@shared/schemas";
import { unknownProjectError, unknownWorktreeError } from "@shared/errors";
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
    opts?: { background?: boolean; timeoutMs?: number },
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
  const code = result.docs.find((doc) => doc["ok"] === false)?.["code"];
  if (code === "unknown-project" && ids.projectId !== undefined) {
    return unknownProjectError(ids.projectId);
  }
  if (code === "unknown-worktree" && ids.worktreeId !== undefined) {
    return unknownWorktreeError(ids.worktreeId);
  }
  return new Error(runner().cliFailureMessage(result, fallback));
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
  const result = await runner().runCli(args, (doc) => {
    if (doc.event === "script") notifyScriptDoc(notify, doc);
  });
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] === true) return { ok: true };
  if (final?.["ok"] === false && final["cleanupError"] !== undefined) {
    return {
      ok: false,
      cleanupError: CleanupErrorSchema.parse(final["cleanupError"]),
    };
  }
  throw cliFailure(result, "sm rm failed", { worktreeId: input.worktreeId });
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
// contributes manager detection and the SHIGOMORI_* env. The branches
// ride along so the CLI reuses the resolution the IPC handler already
// performed instead of re-spawning git for it, --skip-use-log keeps
// the use-log bump in the app's own process (whose state watcher
// suppresses it as a self-write), and `--` guards a script name that
// looks like a flag.
export function cliRunScriptSpawn(args: {
  projectId: string;
  worktreeId: string;
  scriptName: string;
  projectBranch: string;
  defaultBranch: string;
}): string {
  const binary = runner().requireCliBinary();
  return [
    shellQuote(binary),
    "run",
    "--project-id",
    shellQuote(args.projectId),
    "--worktree-id",
    shellQuote(args.worktreeId),
    "--project-branch",
    shellQuote(args.projectBranch),
    "--default-branch",
    shellQuote(args.defaultBranch),
    "--skip-use-log",
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
// create/unpack are ALWAYS app-chosen temp paths (the sync host module
// and fetchBundle own them); the CLI writes/reads exactly where told,
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
// extras (script reaping, icon cache, collapsed prefs) stay with the
// caller because those registries live in the app's process.
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
