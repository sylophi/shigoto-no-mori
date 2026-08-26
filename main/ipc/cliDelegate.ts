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
import {
  requireCliBinary,
  runCli,
  type CliDoc,
  type CliResult,
  cliFailureMessage,
} from "../electron/cliRunner";
import { shellQuote } from "@host/lib/scripts/process";

// Renderer-bound emit callbacks supplied by the IPC handler, fed from
// the CLI's streamed lifecycle documents.
interface WorktreeOperationNotifiers {
  notifyPhase: (payload: WorktreeLifecyclePhase) => void;
  notifyCarryOverComplete: (payload: WorktreeCarryOverComplete) => void;
  notifyScript: (payload: ScriptEvent) => void;
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
  return new Error(cliFailureMessage(result, fallback));
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
function runStreamingCreate(
  args: string[],
  project: Project,
  worktreeId: string | undefined,
  notify: WorktreeOperationNotifiers,
  failureLabel: string,
): Promise<CreateWorktreeResult> {
  return new Promise((resolve, reject) => {
    let created: Worktree | null = null;
    const onDoc = (doc: CliDoc) => {
      switch (doc.event) {
        case "created": {
          created = WorktreeSchema.parse(doc["worktree"]);
          resolve({ worktree: created });
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
        case "script": {
          const { event: _event, ...scriptEvent } = doc;
          notify.notifyScript(ScriptEventSchema.parse(scriptEvent));
          break;
        }
      }
    };
    runCli(args, (doc) => {
      // A schema mismatch before "created" fails the whole call; after
      // it the promise is already resolved, so surface it as a log
      // instead of losing it inside the stream reader.
      try {
        onDoc(doc);
      } catch (error) {
        if (created === null) reject(error as Error);
        else console.warn("[cli] mid-stream document failed validation", error);
      }
    }).then((result) => {
      if (created === null) {
        reject(cliFailure(result, failureLabel, { worktreeId }));
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
  },
  notify: WorktreeOperationNotifiers,
): Promise<CreateWorktreeResult> {
  const args = ["create", "--project-id", project.id];
  if (input.worktreeName) args.push(input.worktreeName);
  if (input.branchName) args.push("--branch", input.branchName);
  if (input.base) args.push("--base", input.base);
  if (input.checkout) args.push("--checkout");
  return runStreamingCreate(
    args,
    project,
    undefined,
    notify,
    "sm create failed",
  );
}

export function adoptViaCli(
  project: Project,
  worktreeId: string,
  notify: WorktreeOperationNotifiers,
): Promise<CreateWorktreeResult> {
  // --force: the app's convert flow already confirmed the wipe in its
  // dialog.
  const args = [
    "adopt",
    "--project-id",
    project.id,
    "--worktree-id",
    worktreeId,
    "--force",
  ];
  return runStreamingCreate(
    args,
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
  const args = [
    "rm",
    "--project-id",
    project.id,
    "--worktree-id",
    input.worktreeId,
  ];
  if (input.force) args.push("--force");
  if (input.skipCleanup) args.push("--skip-cleanup");
  const result = await runCli(args, (doc) => {
    if (doc.event === "script") {
      const { event: _event, ...scriptEvent } = doc;
      notify.notifyScript(ScriptEventSchema.parse(scriptEvent));
    }
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
  const result = await runCli([
    "done",
    "--project-id",
    project.id,
    "--worktree-id",
    worktreeId,
    "--force",
  ]);
  const final = finalOkDoc(result, "sm done failed", { worktreeId });
  return WorktreeSchema.parse(final["worktree"]);
}

export async function mergeViaCli(
  project: Project,
  number: number,
  method: string,
): Promise<void> {
  const result = await runCli([
    "merge",
    "--project-id",
    project.id,
    "--number",
    String(number),
    "--method",
    method,
  ]);
  finalOkDoc(result, "sm merge failed", { projectId: project.id });
}

export async function setShelvedViaCli(
  project: Project,
  worktreeId: string,
  shelved: boolean,
): Promise<void> {
  const result = await runCli([
    shelved ? "shelve" : "unshelve",
    "--project-id",
    project.id,
    "--worktree-id",
    worktreeId,
  ]);
  finalOkDoc(result, "sm shelve failed", { worktreeId });
}

export async function projectsAddViaCli(path: string): Promise<Project> {
  const result = await runCli(["projects", "add", path]);
  const doc = result.docs.findLast(
    (d) => typeof d["id"] === "string" && typeof d["path"] === "string",
  );
  if (result.code !== 0 || doc === undefined) {
    throw cliFailure(result, "sm projects add failed");
  }
  return ProjectSchema.parse(doc);
}

// The command that runs a package.json script through the CLI
// engine. Unlike the functions above this doesn't
// spawn anything: package-script runs go through startScript so the
// app's registry keeps owning streaming, cancel, and quit-time
// reaping -- the CLI contributes manager detection and the
// SHIGOMORI_* env. The branches ride along so the CLI reuses the
// resolution the IPC handler already performed instead of re-spawning
// git for it, --skip-use-log keeps the use-log bump in the app's own
// process (whose state watcher suppresses it as a self-write), and
// `--` guards a script name that looks like a flag.
export function cliRunScriptSpawn(args: {
  projectId: string;
  worktreeId: string;
  scriptName: string;
  projectBranch: string;
  defaultBranch: string;
}): string {
  const binary = requireCliBinary();
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
// lock+atomic merge, and -- for project config -- the in-project
// exclude side effect). The payloads were already zod-parsed at the
// IPC boundary. The CLI merges the payload into the file rather than
// replacing it, so a key written by a newer version survives a save
// from an older one, and it re-checks the shape so engine drift fails
// loudly. Callers must invalidate the TTL caches themselves: runCli's
// self-write note suppresses the state watcher for these writes.
export async function globalConfigWriteViaCli(
  config: GlobalConfig,
): Promise<void> {
  const result = await runCli([
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
  const result = await runCli([
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

// Registry removal and per-project state deletion only; the app-side
// extras (script reaping, icon cache, collapsed prefs) stay with the
// caller because those registries live in the app's process.
export async function projectsRemoveViaCli(projectId: string): Promise<void> {
  const result = await runCli([
    "projects",
    "remove",
    "--project-id",
    projectId,
    "--yes",
  ]);
  finalOkDoc(result, "sm projects remove failed", { projectId });
}
