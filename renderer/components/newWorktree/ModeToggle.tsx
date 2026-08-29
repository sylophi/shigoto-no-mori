import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";

export type Mode = "branch-from" | "checkout" | "pull-request";

export function ModeToggle({
  mode,
  onChange,
  disabled,
  // Set when the pull request source can't be offered (no gh, no GitHub
  // remote). Greys that option out and doubles as its tooltip. The form
  // prints the same line under the control.
  pullRequestUnavailable,
  // Drops the pull request option entirely, for a form pointed at
  // another machine: `gh` runs here, so that source only ever produces a
  // local checkout. Greying it out would suggest it might come back.
  hidePullRequest,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
  pullRequestUnavailable?: string;
  hidePullRequest?: boolean;
}) {
  const pullRequest: SegmentedOption<Mode>[] = hidePullRequest
    ? []
    : [
        {
          value: "pull-request",
          label: "From pull request",
          disabled: pullRequestUnavailable !== undefined,
          title: pullRequestUnavailable,
        },
      ];
  return (
    <SegmentedControl
      aria-label="Worktree source mode"
      value={mode}
      onChange={onChange}
      // Pull request leads: it's the source the form opens on wherever
      // it's offered, and the selected segment should be the one your
      // eye lands on first. Order stays fixed when it isn't offered --
      // segments that reshuffle once the availability check lands would
      // move out from under the cursor.
      options={[
        ...pullRequest,
        { value: "branch-from", label: "Branch from source" },
        { value: "checkout", label: "Check out source" },
      ]}
      disabled={disabled}
    />
  );
}
