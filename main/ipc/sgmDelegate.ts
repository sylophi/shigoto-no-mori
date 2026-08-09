// Routes the five lifecycle mutations through the bundled sgm CLI so
// the app and a terminal run the exact same engine (the user's core
// requirement: deterministic behavior across surfaces). Each function
// mirrors its TS-engine counterpart's IPC contract -- same return
// shapes, same renderer notifications -- translating sgm's NDJSON
// stream into the notifier calls the renderer already understands.
// Callers gate on sgmAvailable(); Windows (no CLI) stays on the TS
// engine.
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
import { runSgm, type SgmDoc, sgmFailureMessage } from "../electron/sgmRunner";
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
    const onDoc = (doc: SgmDoc) => {
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
    runSgm(args, onDoc).then((result) => {
      if (created === null) {
        reject(new Error(sgmFailureMessage(result, failureLabel)));
      }
    }, reject);
  });
}

export function createViaSgm(
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
  return runStreamingCreate(args, project, notify, "sgm create failed");
}

export function adoptViaSgm(
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
  return runStreamingCreate(args, project, notify, "sgm adopt failed");
}

export async function deleteViaSgm(
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
  const result = await runSgm(args, (doc) => {
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
  throw new Error(sgmFailureMessage(result, "sgm rm failed"));
}

export async function doneViaSgm(
  project: Project,
  worktreeId: string,
): Promise<Worktree> {
  // --force: the app's cleanup box appears in merged-PR context, so the
  // UI has already gated mergedness -- matching the TS engine, which
  // performs no ancestor check of its own.
  const result = await runSgm([
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
  throw new Error(sgmFailureMessage(result, "sgm done failed"));
}

export async function mergeViaSgm(
  project: Project,
  number: number,
  method: string,
): Promise<void> {
  const result = await runSgm([
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
    throw new Error(sgmFailureMessage(result, "sgm merge failed"));
  }
}
