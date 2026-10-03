// The worktree footer's leading verbs as drawn, one per kind: Files,
// Ports, a running mirror's button, and this device's own Mirror to…
// and Transplant to…. The buttons that open them (FilesButton,
// PortsButton, mirror/MirrorAction, PeerTransferActions) say which and
// handle the click.
import { Cable, FolderSearch, RefreshCw, Shovel } from "lucide-react";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { FooterActionButton } from "./FooterActionButton";
import { LABEL_RANK } from "./footerFit";

const noop = () => undefined;

// The repo identity a worktree travels under to another device (Mirror
// to…, Transplant to…), or null when it cannot: it needs a real branch
// of its own and a repo the other device can recognise.
export function transferIdentity(
  worktree: Pick<Worktree, "detached" | "branch">,
  project: Pick<Project, "identity">,
): string | null {
  if (worktree.detached || !isRealBranch(worktree.branch)) return null;
  return project.identity ?? null;
}

// Whether a worktree can be transplanted away: every one but the
// primary checkout, which is the project itself and cannot be torn
// down.
export function canTransplantAway(worktree: Pick<Worktree, "isPrimary">) {
  return !worktree.isPrimary;
}

export type FooterLeadingVerb =
  | { kind: "files" }
  // The ports this machine forwards from a peer's worktree, which tint
  // the glyph and make its title.
  | { kind: "ports"; forwardTip?: string }
  // A mirror the worktree is part of, with the other device's name.
  | { kind: "mirror"; other: string }
  | { kind: "mirrorTo"; disabledReason?: string }
  | { kind: "transplantTo" };

export function FooterLeadingVerbView({
  verb,
  onClick = noop,
}: {
  verb: FooterLeadingVerb;
  onClick?: () => void;
}) {
  switch (verb.kind) {
    case "files":
      return (
        <FooterActionButton
          rank={LABEL_RANK.files}
          icon={<FolderSearch />}
          label="Files"
          title="Browse this worktree's files"
          onClick={onClick}
        />
      );
    case "ports":
      return (
        <FooterActionButton
          rank={LABEL_RANK.ports}
          icon={
            <Cable
              className={
                verb.forwardTip !== undefined ? TONE_TEXT.emerald : undefined
              }
            />
          }
          label="Ports"
          title={verb.forwardTip ?? "See this worktree's ports"}
          onClick={onClick}
        />
      );
    case "mirror":
      return (
        <FooterActionButton
          rank={LABEL_RANK.mirror}
          icon={<RefreshCw />}
          label={`Mirror with ${verb.other}`}
          onClick={onClick}
        />
      );
    case "mirrorTo":
      return (
        <FooterActionButton
          rank={LABEL_RANK.mirrorTo}
          icon={<RefreshCw />}
          label="Mirror to…"
          title="Keep a live copy of this worktree on another device"
          disabledReason={verb.disabledReason}
          onClick={onClick}
        />
      );
    case "transplantTo":
      return (
        <FooterActionButton
          rank={LABEL_RANK.transplant}
          icon={<Shovel />}
          label="Transplant to…"
          title="Move this worktree to another device"
          onClick={onClick}
        />
      );
  }
}
