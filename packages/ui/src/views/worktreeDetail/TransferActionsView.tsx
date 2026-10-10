// A worktree's two transfers between devices, in either direction: a
// live copy kept in step ("Mirror", a footer verb) and a move
// ("Transplant", a row of the Options popover, used far less). On this
// device's worktree they go to another device, on a peer's they come
// here. The page draws it twice, the footer part with the open dialog
// and the option part, so the dialog outlives the popover that opened
// it. Which transfers a worktree can take is the container's to say.
import type { ReactNode } from "react";
import { RefreshCw, Shovel } from "lucide-react";
import { FooterActionButtonView } from "./FooterActionButtonView.tsx";
import { LABEL_RANK } from "./FooterVerbView.tsx";
import { OptionActionView } from "./WorktreeOptionsView.tsx";

export type TransferDialog = "mirror" | "transplant" | null;

export function TransferActionsView({
  part,
  here,
  mirror,
  transplant,
  dialog,
  onOpen,
}: {
  part: "footer" | "option";
  // A peer's worktree, coming to this device.
  here: boolean;
  // Whether Mirror shows, and why it can't start right now.
  mirror: { blocker: string | undefined } | null;
  transplant: boolean;
  // The open dialog, drawn with the footer part.
  dialog: ReactNode;
  onOpen: (dialog: "mirror" | "transplant") => void;
}) {
  const where = here ? "this device" : "another device";
  if (part === "option") {
    return (
      transplant && (
        <OptionActionView
          icon={<Shovel />}
          label="Transplant"
          description={`Move this worktree to ${where}.`}
          onClick={() => onOpen("transplant")}
        />
      )
    );
  }
  return (
    <>
      {mirror && (
        <FooterActionButtonView
          rank={LABEL_RANK.mirrorTo}
          icon={<RefreshCw />}
          label="Mirror"
          tip={`Keep a live copy of this worktree on ${where}`}
          disabledReason={mirror.blocker}
          onClick={() => onOpen("mirror")}
        />
      )}
      {dialog}
    </>
  );
}
