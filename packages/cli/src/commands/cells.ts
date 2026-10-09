// The cells a worktree's table row, status card and menu share.
import type * as Worktrees from "@shigomori/engine/Worktrees";
import type { Styles } from "../output.ts";

// Cut to `max` columns, the last one an ellipsis.
export const truncate = (text: string, max: number) => {
  const chars = [...text];
  return max < 2 || chars.length <= max
    ? text
    : `${chars.slice(0, max - 1).join("")}…`;
};

// The ↑ahead ↓behind cell, `even` with no divergence. A status card
// says the same of the upstream and the base.
export const divergenceCell = (
  paint: Styles,
  ahead: number,
  behind: number,
  even: string,
) =>
  ahead === 0 && behind === 0
    ? paint.green(even)
    : [
        ahead > 0 ? paint.cyan(`↑${ahead}`) : "",
        behind > 0 ? paint.yellow(`↓${behind}`) : "",
      ]
        .filter((part) => part !== "")
        .join(" ");

// A worktree's flags: primary before external, and never both.
export const flagNames = (
  row: Pick<
    Worktrees.IdentityRow,
    "isPrimary" | "isExternal" | "shelved" | "autoPull" | "agentWorking"
  >,
) =>
  [
    row.isPrimary ? "primary" : row.isExternal ? "external" : "",
    row.shelved ? "shelved" : "",
    row.autoPull ? "auto-pull" : "",
    row.agentWorking ? "agent working" : "",
  ].filter((flag) => flag !== "");

// A title cut to fit a terminal line.
export const titleCell = (title: string | undefined) =>
  truncate(title ?? "", 50);

export const syncCell = (paint: Styles, row: Worktrees.WorktreeRow) =>
  row.detached
    ? paint.yellow("detached")
    : row.hasUpstream
      ? divergenceCell(paint, row.ahead, row.behind, "synced")
      : paint.dim("local");

export const changesCell = (paint: Styles, row: Worktrees.WorktreeRow) =>
  row.changedCount > 0
    ? paint.yellow(`${row.changedCount} changed`)
    : paint.dim("clean");

export const flagsCell = (
  paint: Styles,
  row: Parameters<typeof flagNames>[0],
) => paint.dim(flagNames(row).join(", "));
