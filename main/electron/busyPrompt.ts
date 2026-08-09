// Native confirmation when the user tries to quit or restart-to-update
// while scripts or worktree removals are in flight. Centralizing the
// copy here keeps the two paths' wording in lock-step.
import { BrowserWindow, dialog } from "electron";
import { type BusyOperations, getBusyOperations } from "../lib/scripts";
import { sgmChildCount } from "./sgmRunner";

// sgm children are lifecycle operations in flight (create/delete via
// the CLI engine); count them like the TS engine's inflight deletes so
// quitting mid-operation still prompts.
function busyIncludingSgm(): BusyOperations {
  const busy = getBusyOperations();
  return {
    runningScripts: busy.runningScripts,
    inflightDeletes: busy.inflightDeletes + sgmChildCount(),
  };
}

type BusyAction = "quit" | "restart";

const COPY: Record<
  BusyAction,
  { message: string; proceed: string; gerund: string }
> = {
  quit: {
    message: "Stop running tasks and quit?",
    proceed: "Quit anyway",
    gerund: "Quitting",
  },
  restart: {
    message: "Stop running tasks and restart to update?",
    proceed: "Restart anyway",
    gerund: "Restarting",
  },
};

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function formatBusyDetail(busy: BusyOperations, gerund: string): string {
  // Lifecycle deletes spawn a teardown script that lands in
  // runningScripts, so prefer the script count to avoid double-counting
  // the same operation when both are non-zero.
  if (busy.runningScripts > 0) {
    const n = busy.runningScripts;
    const subject = pluralize(n, `${n} script is`, `${n} scripts are`);
    const obj = pluralize(n, "it", "them");
    return `${subject} still running. ${gerund} now will stop ${obj}.`;
  }
  const n = busy.inflightDeletes;
  const subject = pluralize(n, `${n} worktree is`, `${n} worktrees are`);
  return `${subject} being removed. ${gerund} now will interrupt cleanup and may leave files behind.`;
}

function parentWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) return w;
  }
  return undefined;
}

function buildDialogOptions(action: BusyAction, busy: BusyOperations) {
  const copy = COPY[action];
  return {
    type: "warning" as const,
    buttons: ["Cancel", copy.proceed],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: formatBusyDetail(busy, copy.gerund),
  };
}

function isBusy(busy: BusyOperations): boolean {
  return busy.runningScripts > 0 || busy.inflightDeletes > 0;
}

export function confirmBusyActionSync(action: BusyAction): boolean {
  const busy = busyIncludingSgm();
  if (!isBusy(busy)) return true;
  const parent = parentWindow();
  const opts = buildDialogOptions(action, busy);
  const choice = parent
    ? dialog.showMessageBoxSync(parent, opts)
    : dialog.showMessageBoxSync(opts);
  return choice === 1;
}

export async function confirmBusyAction(action: BusyAction): Promise<boolean> {
  const busy = busyIncludingSgm();
  if (!isBusy(busy)) return true;
  const parent = parentWindow();
  const opts = buildDialogOptions(action, busy);
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 1;
}
