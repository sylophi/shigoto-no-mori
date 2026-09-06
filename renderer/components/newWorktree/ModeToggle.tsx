import { SegmentedControl } from "@/components/ui/segmented-control";

export type Mode = "branch-from" | "checkout" | "pull-request";

export function ModeToggle({
  mode,
  onChange,
  disabled,
  // Set when the pull request source can't be offered (no gh, no GitHub
  // remote). Greys that option out and doubles as its tooltip. The form
  // prints the same line under the control.
  pullRequestUnavailable,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
  pullRequestUnavailable?: string;
}) {
  return (
    <SegmentedControl
      aria-label="Worktree source mode"
      value={mode}
      onChange={onChange}
      // Pull request leads: it's the source the form opens on, and the
      // selected segment should be the one your eye lands on first.
      // It stays in place when unavailable rather than dropping out --
      // segments that reshuffle once the availability check lands
      // would move out from under the cursor.
      options={[
        {
          value: "pull-request",
          label: "From pull request",
          disabled: pullRequestUnavailable !== undefined,
          title: pullRequestUnavailable,
        },
        { value: "branch-from", label: "Branch from source" },
        { value: "checkout", label: "Check out source" },
      ]}
      disabled={disabled}
    />
  );
}
