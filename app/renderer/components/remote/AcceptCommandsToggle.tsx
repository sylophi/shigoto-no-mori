// "Allow control from other devices": whether THIS machine runs the
// commands the account's other devices send it. The decision sits on the
// machine being driven, in its own registry row, because that is the
// machine whose owner is exposing something. There is nothing to
// configure per peer: every device on the account is the same
// person's, so the only question is whether this one takes orders at
// all. Off, the machine is still browsable from everywhere, since
// reads were never gated.
//
// It is the loudest switch in the app (a peer holding it can edit the
// setup script and then run it, which is any command as the user, over
// the tunnel from anywhere), so its row sits in a panel of its own that
// spells out what the grant covers and tints while it is on
// (AcceptCommandsToggleView).
//
// Written immediately through the host store, never staged in a form:
// flipping it is the whole action. The registry mounts the watcher
// that follows a flip made in another window.
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
