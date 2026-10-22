import { useEffect, useRef } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import { ScriptConsole } from "@/components/scriptConsole/ScriptConsole";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useScopedDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useTerminals } from "@/hooks/terminals/useTerminals";
import { notifyError } from "@/lib/toast";
import { scriptTabId, terminalTabLabel } from "@/store/terminalDrawer";
import { slotLabel, type ScriptSlot } from "@/store/scriptSlot";
import { Terminal } from "./Terminal";
import { TerminalTabsView } from "@shigomori/ui/views/terminal/TerminalTabsView.tsx";
import { peerTerminalsHiddenNote } from "@shigomori/ui/lib/commandAccessCopy.ts";

type TerminalTabsProps = Parameters<typeof AttachedTerminalTabs>[0];

// The tabs while this device may command the scoped one; while it may
// not (its control turned off, with a terminal open here), the words
// that say so in their place, and the attached terminal ends with
// them. The pick is kept by the drawer, so control coming back opens
// them where they were, or a new terminal if none is left, as the tabs
// do whenever they mount with none.
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

// The scoped device's terminals of a worktree, and the script consoles
// opened beside them, as tabs over the picked one, the newest terminal
// until another is picked. Only the picked one is attached and drawn.
// With no tab at all, a terminal is opened as it mounts, and `onEmpty`
// hears when the last tab goes.
function AttachedTerminalTabs({
  worktree,
  slots,
  onCloseScript,
  picked,
  onPick: pick,
  onEmpty,
  onHide,
}: {
  worktree: Worktree;
  // The consoles open as tabs, and how one closes.
  slots: readonly ScriptSlot[];
  onCloseScript: (slot: ScriptSlot) => void;
  picked: string | null;
  onPick: (tab: string) => void;
  onEmpty: () => void;
  onHide: () => void;
}) {
  const { api } = useHostScope();
  const owner = { projectId: worktree.projectId, worktreeId: worktree.id };
  const terminals = useTerminals()?.filter(
    (terminal) =>
      terminal.projectId === owner.projectId &&
      terminal.worktreeId === owner.worktreeId,
  );
  const tabs = [
    ...(terminals ?? []).map((terminal, i) => ({
      id: terminal.terminalId,
      label: terminalTabLabel(i),
    })),
    ...slots.map((slot) => ({ id: scriptTabId(slot), label: slotLabel(slot) })),
  ];
  const selectedId = tabs.some((tab) => tab.id === picked)
    ? picked
    : (terminals?.at(-1)?.terminalId ?? tabs.at(-1)?.id ?? null);
  const pickedSlot = slots.find((slot) => scriptTabId(slot) === selectedId);

  const open = () =>
    void api
      .run(api.terminals.open(owner))
      .then(({ terminalId }) => pick(terminalId))
      .catch((error: unknown) =>
        notifyError("Couldn't open a terminal", error),
      );

  // Once per mount: the first answer with no tab at all opens a
  // terminal, and no tab left after some were there is the last one
  // closing.
  const seen = useRef<"waiting" | "opened" | "had">("waiting");
  const count = terminals === undefined ? undefined : tabs.length;
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
      onEmpty();
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
          onCloseScript(slot);
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
    >
      {pickedSlot !== undefined ? (
        <ScriptConsole worktree={worktree} slot={pickedSlot} />
      ) : (
        selectedId !== null && (
          <Terminal key={selectedId} terminalId={selectedId} />
        )
      )}
    </TerminalTabsView>
  );
}
