// The cells a worktree's table row and status card share.
import type * as Worktrees from "@shigomori/engine/Worktrees";
import type { styles } from "../output.ts";

export type Styles = ReturnType<typeof styles>;

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
