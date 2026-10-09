// This machine's control switch (AcceptCommandsToggleView), written
// immediately through the host store.
import {
  useAcceptsCommands,
  useSetAcceptsCommands,
} from "@/hooks/account/useAccount";
import { AcceptCommandsToggleView } from "./AcceptCommandsToggleView";

export function AcceptCommandsToggle() {
  const { data: enabled, isError } = useAcceptsCommands();
  const setAcceptsCommands = useSetAcceptsCommands();
  return (
    <AcceptCommandsToggleView
      enabled={enabled}
      isError={isError}
      pending={setAcceptsCommands.isPending}
      onChange={(next) => setAcceptsCommands.mutate(next)}
    />
  );
}
