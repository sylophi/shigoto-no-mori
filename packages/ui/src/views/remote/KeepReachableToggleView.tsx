// "Keep this device reachable": the one device fact the account's OTHER
// machines depend on, so it belongs to THIS device's registry row
// rather than to a lone section at the bottom of the page. Indented
// under the row it modifies, it reads as a property of that machine --
// which is exactly what it is, and what the copy has to keep saying
// ("applies to this machine only") when the control floats free.
//
// Written immediately through the client store, never staged in a form:
// flipping it is the whole action.
import { ToggleRowView } from "../shared/ToggleRowView.tsx";

export function KeepReachableToggleView({
  on,
  pending,
  onChange,
}: {
  on: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <ToggleRowView
      checked={on}
      onCheckedChange={onChange}
      disabled={pending}
      label="Keep this device reachable"
      description="Starts Shigoto no Mori when you log in and relaunches it after a recoverable crash, so this machine stays available to your account."
    />
  );
}
