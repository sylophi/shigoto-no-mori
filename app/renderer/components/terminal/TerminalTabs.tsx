import { useEffect, useRef, useState } from "react";
import type {
  Terminal as TerminalInfo,
  TerminalOwner,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useTerminals } from "@/hooks/terminals/useTerminals";
import { notifyError } from "@/lib/toast";
import { Terminal } from "./Terminal";
import { TerminalTabsView } from "./TerminalTabsView";

const ownedBy = (terminal: TerminalInfo, owner: TerminalOwner): boolean =>
  owner.kind === "device"
    ? terminal.owner.kind === "device"
    : terminal.owner.kind === "worktree" &&
      terminal.owner.projectId === owner.projectId &&
      terminal.owner.worktreeId === owner.worktreeId;

// The scoped device's terminals of one owner, as tabs over the picked
// one, the newest until another is picked. Only the picked one is
// attached and drawn. With none open, one is opened as it mounts, and
// `onEmpty` hears when the last one closes.
export function TerminalTabs({
  owner,
  picked: pickedProp,
  onPick,
  onEmpty,
  onHide,
}: {
  owner: TerminalOwner;
  // The pick, when the place this sits in keeps it (a page's URL).
  picked?: string | null;
  onPick?: (terminalId: string) => void;
  onEmpty?: () => void;
  onHide?: () => void;
}) {
  const { api } = useHostScope();
  const listed = useTerminals();
  const terminals = listed?.filter((terminal) => ownedBy(terminal, owner));
  const [pickedState, setPickedState] = useState<string | null>(null);
  const picked = pickedProp === undefined ? pickedState : pickedProp;
  const pick = onPick ?? setPickedState;
  const selectedId = terminals?.some(
    (terminal) => terminal.terminalId === picked,
  )
    ? picked
    : (terminals?.at(-1)?.terminalId ?? null);

  const open = () =>
    void api.terminals
      .open({ owner })
      .then(({ terminalId }) => pick(terminalId))
      .catch((error: unknown) =>
        notifyError("Couldn't open a terminal", error),
      );

  // Once per mount: the first answer with none of the owner's opens
  // one, and a later empty list after some were open is the last one
  // closing.
  const seen = useRef<"waiting" | "opened" | "had">("waiting");
  const count = terminals?.length;
  useEffect(() => {
    if (count === undefined) return;
    if (count > 0) {
      seen.current = "had";
      return;
    }
    if (seen.current === "waiting") {
      seen.current = "opened";
      open();
    } else if (seen.current === "had") {
      onEmpty?.();
    }
  });

  return (
    <TerminalTabsView
      tabs={(terminals ?? []).map((terminal, i) => ({
        id: terminal.terminalId,
        label: `Terminal ${i + 1}`,
      }))}
      selectedId={selectedId}
      onSelect={pick}
      onClose={(terminalId) =>
        void api.terminals
          .close({ terminalId })
          .catch((error: unknown) =>
            notifyError("Couldn't close the terminal", error),
          )
      }
      onNew={open}
      onHide={onHide}
    >
      {selectedId !== null && (
        <Terminal key={selectedId} terminalId={selectedId} />
      )}
    </TerminalTabsView>
  );
}
