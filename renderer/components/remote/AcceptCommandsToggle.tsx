// "Allow control from other devices": whether THIS machine runs the
// commands the account's other devices send it (create and remove
// worktrees, run scripts, change settings). The decision sits on the
// machine being driven, in its own registry row, because that is the
// machine whose owner is exposing something. There is nothing to
// configure per peer: every device on the account is the same
// person's, so the only question is whether this one takes orders at
// all. Off, the machine is still browsable from everywhere, since
// reads were never gated.
//
// Written immediately through the host store, never staged in a form:
// flipping it is the whole action. The registry mounts the watcher
// that follows a flip made in another window.
import { ToggleRow } from "@/components/shared/ToggleRow";
import {
  useAcceptsCommands,
  useSetAcceptsCommands,
} from "@/hooks/account/useAccount";

export function AcceptCommandsToggle() {
  const { data: enabled, isError } = useAcceptsCommands();
  const setAcceptsCommands = useSetAcceptsCommands();

  return (
    <ToggleRow
      checked={enabled === true}
      onCheckedChange={(next) => setAcceptsCommands.mutate(next)}
      // Inert until the first read lands, so the switch never shows a
      // false "off" that a click would then turn into a real write. A
      // read that FAILED is a different case: the switch stays live,
      // reading off, so a click is the retry (a successful write fans
      // out and the read runs again).
      disabled={
        (enabled === undefined && !isError) || setAcceptsCommands.isPending
      }
      label="Allow control from other devices"
      description="Your other devices can create and remove worktrees, run scripts and change settings on this machine. Off keeps it read-only to them."
    />
  );
}
