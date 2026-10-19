import { useEffect, useRef, useState } from "react";
import type {
  Terminal as TerminalInfo,
  TerminalOwner,
  Worktree,
} from "@shigomori/contracts/schemas";
import { ScriptConsole } from "@/components/scriptConsole/ScriptConsole";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useScopedDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useTerminals } from "@/hooks/terminals/useTerminals";
import { notifyError } from "@/lib/toast";
import { scriptTabId } from "@/store/terminalDrawer";
import { slotLabel, type ScriptSlot } from "@/store/scriptSlot";
import { Terminal } from "./Terminal";
import { TerminalTabsView } from "@shigomori/ui/views/terminal/TerminalTabsView.tsx";
import { peerTerminalsHiddenNote } from "@shigomori/ui/lib/commandAccessCopy.ts";

const ownedBy = (terminal: TerminalInfo, owner: TerminalOwner): boolean =>
  owner.kind === "device"
    ? terminal.owner.kind === "device"
    : terminal.owner.kind === "worktree" &&
      terminal.owner.projectId === owner.projectId &&
      terminal.owner.worktreeId === owner.worktreeId;

type TerminalTabsProps = Parameters<typeof AttachedTerminalTabs>[0];

// The tabs while this device may command the scoped one; while it may
// not (its control turned off, with a terminal open here), the words
// that say so in their place, and the attached terminal ends with
// them. The pick is kept by the place the tabs sit in, so control
// coming back opens them where they were, or a new terminal if none
// is left, as the tabs do whenever they mount with none.
export function TerminalTabs(props: TerminalTabsProps) {
  const { canCommand } = useCommandAccess();
  const deviceLabel = useScopedDeviceLabel();
  if (canCommand) return <AttachedTerminalTabs {...props} />;
  return (
    <TerminalTabsView
      tabs={[]}
      selectedId={null}
      onSelect={() => {}}
      onClose={() => {}}
      onHide={props.onHide}
      note={peerTerminalsHiddenNote(deviceLabel)}
    >
      {null}
    </TerminalTabsView>
  );
}

// The scoped device's terminals of one owner, and a worktree's script
// consoles opened beside them, as tabs over the picked one, the newest
// terminal until another is picked. Only the picked one is attached
// and drawn. With no tab at all, a terminal is opened as it mounts,
// and `onEmpty` hears when the last tab goes.
function AttachedTerminalTabs({
  owner,
  scripts,
  picked: pickedProp,
  onPick,
  onEmpty,
  onHide,
}: {
  owner: TerminalOwner;
  // The worktree's consoles open as tabs (the drawer's), and how one
  // closes.
  scripts?: {
    readonly worktree: Worktree;
    readonly slots: readonly ScriptSlot[];
    readonly onClose: (slot: ScriptSlot) => void;
  };
  // The pick, when the place this sits in keeps it (a page's URL, the
  // drawer's store).
  picked?: string | null;
  onPick?: (tab: string) => void;
  onEmpty?: () => void;
  onHide?: () => void;
}) {
  const { api } = useHostScope();
  const listed = useTerminals();
  const terminals = listed?.filter((terminal) => ownedBy(terminal, owner));
  const slots = scripts?.slots ?? [];
  const [pickedState, setPickedState] = useState<string | null>(null);
  const picked = pickedProp === undefined ? pickedState : pickedProp;
  const pick = onPick ?? setPickedState;
  const tabs = [
    ...(terminals ?? []).map((terminal, i) => ({
      id: terminal.terminalId,
      label: `Terminal ${i + 1}`,
    })),
    ...slots.map((slot) => ({ id: scriptTabId(slot), label: slotLabel(slot) })),
  ];
  const selectedId = tabs.some((tab) => tab.id === picked)
    ? picked
    : (terminals?.at(-1)?.terminalId ?? tabs.at(-1)?.id ?? null);
  const pickedSlot = slots.find((slot) => scriptTabId(slot) === selectedId);

  const open = () =>
    void api
      .run(api.terminals.open({ owner }))
      .then(({ terminalId }) => pick(terminalId))
      .catch((error: unknown) =>
        notifyError("Couldn't open a terminal", error),
      );

  // Once per mount: the first answer with no tab at all opens a
  // terminal, and no tab left after some were there is the last one
  // closing.
  const seen = useRef<"waiting" | "opened" | "had">("waiting");
  const count = terminals === undefined ? undefined : tabs.length;
  const [hadTabs, setHadTabs] = useState(false);
  if (count !== undefined && count > 0 && !hadTabs) setHadTabs(true);
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
      tabs={tabs}
      selectedId={selectedId}
      onSelect={pick}
      onClose={(id) => {
        const slot = slots.find((each) => scriptTabId(each) === id);
        if (slot !== undefined) {
          scripts?.onClose(slot);
          return;
        }
        void api
          .run(api.terminals.close({ terminalId: id }))
          .catch((error: unknown) =>
            notifyError("Couldn't close the terminal", error),
          );
      }}
      onNew={open}
      onHide={onHide}
      empty={onEmpty === undefined && count === 0 && hadTabs}
    >
      {pickedSlot !== undefined && scripts !== undefined ? (
        <ScriptConsole worktree={scripts.worktree} slot={pickedSlot} />
      ) : (
        selectedId !== null && (
          <Terminal key={selectedId} terminalId={selectedId} />
        )
      )}
    </TerminalTabsView>
  );
}
