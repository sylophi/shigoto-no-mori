// The local worktree footer's ways out to another of the account's
// devices, as a rule: which of "Mirror to…" and "Transplant to…" a
// worktree offers. Apart from the buttons (PeerTransferActions), so a
// picture of the footer (lab/scenes) offers the same.
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import type { FooterLeadingVerb } from "./FooterLeadingVerbView";

// The repo identity a worktree travels under to another device, or
// null when it cannot: it needs a real branch of its own and a repo
// the other device can recognise.
export function transferIdentity(
  worktree: Pick<Worktree, "detached" | "branch">,
  project: Pick<Project, "identity">,
): string | null {
  if (worktree.detached || !isRealBranch(worktree.branch)) return null;
  return project.identity ?? null;
}

type TransferVerb = Extract<
  FooterLeadingVerb,
  { kind: "mirrorTo" | "transplantTo" }
>;

export function transferVerbs({
  worktree,
  project,
  hasTargets,
  canMirror,
  mirrorBlocker,
}: {
  worktree: Pick<Worktree, "detached" | "branch" | "isPrimary">;
  project: Pick<Project, "identity">;
  // Another device that hosts projects is there to take it.
  hasTargets: boolean;
  // This client can start a mirror (the app, whose main process holds
  // the daemon) and the worktree is not already part of one, which a
  // worktree holds one of.
  canMirror: boolean;
  // Why a mirror cannot start right now, which greys the button out.
  mirrorBlocker: string | undefined;
}): TransferVerb[] {
  if (transferIdentity(worktree, project) === null || !hasTargets) return [];
  const verbs: TransferVerb[] = [];
  if (canMirror)
    verbs.push({ kind: "mirrorTo", disabledReason: mirrorBlocker });
  // The primary checkout can be mirrored but not transplanted: it is
  // the project itself and cannot be torn down.
  if (!worktree.isPrimary) verbs.push({ kind: "transplantTo" });
  return verbs;
}
