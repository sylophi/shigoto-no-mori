import { ToggleRow } from "@/components/shared/ToggleRow";

// "Share with other devices": whether THIS machine serves the account's
// other devices anything at all.
export function ShareDataToggleView({
  on,
  disabled,
  onChange,
}: {
  // Undefined until the first read lands.
  on: boolean | undefined;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <ToggleRow
      checked={on === true}
      onCheckedChange={onChange}
      disabled={disabled}
      label="Share with other devices"
      description={
        on === false
          ? "Your other devices can't see anything on this machine."
          : "Your other devices can see this machine's projects and worktrees."
      }
    />
  );
}
