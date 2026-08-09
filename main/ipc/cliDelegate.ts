// Routes the app's state mutations through the bundled CLI so the app
// and a terminal run the exact same engine (the user's core
// requirement: deterministic behavior across surfaces): worktree
// create/adopt/delete/done/merge, the shelved flag, and project
// add/remove. Each function mirrors its TS-engine counterpart's IPC
// contract -- same return shapes, same renderer notifications --
// translating the CLI's NDJSON stream into the notifier calls the
// renderer already understands. Callers gate on cliAvailable();
// Windows (no CLI) stays on the TS engine.
import type {
  CarryOverReport,
  CleanupError,
  CreatePhase,
  CreateWorktreeResult,
  DeleteWorktreeResult,
  Project,
  ScriptEvent,
  Worktree,
} from "@shared/schemas";
import { runCli, type CliDoc, cliFailureMessage } from "../electron/cliRunner";
import type { WorktreeOperationNotifiers } from "../lib/worktrees/operations";

// Streamed create/adopt: resolve the IPC promise on the "created"
// document (the app navigates immediately, like the TS engine's
// fire-and-forget lifecycle) and keep forwarding lifecycle events to
// the renderer until the process exits.
function runStreamingCreate(
  args: string[],
  project: Project,
  notify: WorktreeOperationNotifiers,
  failureLabel: string,
): Promise<CreateWorktreeResult> {
  return new Promise((resolve, reject) => {
    let created: Worktree | null = null;
    const onDoc = (doc: CliDoc) => {
      switch (doc.event) {
        case "created": {
          created = doc["worktree"] as Worktree;
          resolve({ worktree: created });
          break;
        }
        case "phase": {
          if (!created) break;
          notify.notifyPhase({
            projectId: project.id,
            worktreeId: created.id,
            phase: doc["phase"] as CreatePhase | "idle",
          });
          break;
        }
        case "carryOver": {
          if (!created) break;
          notify.notifyCarryOverComplete({
            projectId: project.id,
            worktreeId: created.id,
            report: doc["report"] as CarryOverReport,
          });
          break;
        }
        case "script": {
          const { event: _event, ...scriptEvent } = doc;
          notify.notifyScript(scriptEvent as ScriptEvent);
          break;
        }
      }
    };
    runCli(args, onDoc).then((result) => {
      if (created === null) {
        reject(new Error(cliFailureMessage(result, failureLabel)));
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
  return runStreamingCreate(args, project, notify, "sm create failed");
}

export function adoptViaCli(
  project: Project,
  worktreeId: string,
  notify: WorktreeOperationNotifiers,
): Promise<CreateWorktreeResult> {
  // --force: the app's convert flow already confirmed the wipe in its
  // dialog, matching the TS engine's unconditional force-remove.
  const args = [
    "adopt",
    "--project-id",
    project.id,
    "--worktree-id",
    worktreeId,
    "--force",
  ];
  return runStreamingCreate(args, project, notify, "sm adopt failed");
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
      notify.notifyScript(scriptEvent as ScriptEvent);
    }
  });
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] === true) return { ok: true };
  if (final?.["ok"] === false && final["cleanupError"] !== undefined) {
    return { ok: false, cleanupError: final["cleanupError"] as CleanupError };
  }
  throw new Error(cliFailureMessage(result, "sm rm failed"));
}

export async function doneViaCli(
  project: Project,
  worktreeId: string,
): Promise<Worktree> {
  // --force: the app's cleanup box appears in merged-PR context, so the
  // UI has already gated mergedness -- matching the TS engine, which
  // performs no ancestor check of its own.
  const result = await runCli([
    "done",
    "--project-id",
    project.id,
    "--worktree-id",
    worktreeId,
    "--force",
  ]);
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] === true && final["worktree"] !== undefined) {
    return final["worktree"] as Worktree;
  }
  throw new Error(cliFailureMessage(result, "sm done failed"));
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
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] !== true) {
    throw new Error(cliFailureMessage(result, "sm merge failed"));
  }
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
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] !== true) {
    throw new Error(cliFailureMessage(result, "sm shelve failed"));
  }
}

export async function projectsAddViaCli(path: string): Promise<Project> {
  const result = await runCli(["projects", "add", path]);
  const doc = result.docs.findLast(
    (d) => typeof d["id"] === "string" && typeof d["path"] === "string",
  );
  if (result.code !== 0 || doc === undefined) {
    throw new Error(cliFailureMessage(result, "sm projects add failed"));
  }
  return {
    id: doc["id"] as string,
    name: doc["name"] as string,
    path: doc["path"] as string,
  };
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
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] !== true) {
    throw new Error(cliFailureMessage(result, "sm projects remove failed"));
  }
}
