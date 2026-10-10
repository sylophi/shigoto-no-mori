// The Launch section's row of package.json scripts (ScriptLaunchRow
// binds it): the scripts pinned to it, wrapping, or the top scripts
// trimmed to the ones that fit on one line, measured off a hidden copy.
import type { ReactNode, Ref } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

export function ScriptLaunchRowView({
  pinned,
  buttons,
  measure,
}: {
  // The scripts pinned to the row, every one shown.
  pinned: boolean;
  // The pills shown (ScriptLaunchButton).
  buttons: ReactNode;
  // Unpinned: the row and the hidden copy of every candidate's pill it
  // measures them on, so the row shows the ones that fit.
  measure?: {
    rowRef?: Ref<HTMLDivElement>;
    measurerRef?: Ref<HTMLDivElement>;
    names: readonly string[];
  };
}) {
  if (pinned || measure === undefined) {
    return <div className="flex flex-wrap items-center gap-2">{buttons}</div>;
  }
  return (
    <div ref={measure.rowRef} className="relative flex items-center gap-2">
      {buttons}

      {/* inert keeps the natural-width copy out of the tab order and the
          accessibility tree; pointer-events-none alone leaves the duplicated
          buttons focusable. The wrapper is pinned to the row's width and
          clips: a left-0 absolute nowrap box shrink-wraps to its full
          content width, so unclipped it widens the scroll pane's scrollable
          area (horizontal scrollbar). The observed inner div stays w-max so
          pill-width changes (font swap, doubutsu weight remap) resize it
          and re-trigger measurement even while it overflows the wrapper;
          clipping doesn't affect the children's measured rects. */}
      <div
        aria-hidden
        inert
        className="pointer-events-none invisible absolute inset-x-0 top-0 overflow-hidden"
      >
        <div
          ref={measure.measurerRef}
          className="flex w-max items-center gap-2 whitespace-nowrap"
        >
          {measure.names.map((name) => (
            <ScriptPillView key={name} name={name} busy={false} />
          ))}
        </div>
      </div>
    </div>
  );
}

// A script's pill on the row: running it, or stopping it while it
// runs, and its output on a ⌘click.
export function ScriptLaunchButtonView({
  name,
  command,
  busy,
  disabled,
  disabledReason,
  onClick,
}: {
  name: string;
  command: string;
  busy: boolean;
  disabled: boolean;
  disabledReason: string | undefined;
  onClick: (event: React.MouseEvent) => void;
}) {
  return (
    <SimpleTooltip tip={disabledReason ?? `${command}\n⌘click to view output`}>
      <ScriptPillView
        name={name}
        busy={busy}
        disabled={disabled}
        onClick={onClick}
        aria-label={busy ? `Stop ${name}` : `Run ${name}`}
      />
    </SimpleTooltip>
  );
}

// Presentational half, shared by the visible row and the measurer so the two
// can't drift apart. Both icons render at the same size, so a running script
// occupies exactly the width it was measured at.
export function ScriptPillView({
  name,
  busy,
  ...props
}: {
  name: string;
  busy: boolean;
} & React.ComponentProps<typeof Button>) {
  // Pill height tracks the launcher row above it, but the glyph and label
  // inside are the Scripts section's (size-3 icon, text-xs mono). These are
  // scripts, and reading them at the launcher's weight overstates them.
  return (
    <Button variant="outline" size="sm" {...props}>
      {busy ? (
        <Square aria-hidden className="size-3 text-destructive" />
      ) : (
        <Play aria-hidden className="size-3 text-muted-foreground" />
      )}
      <span className="font-mono text-xs">{name}</span>
    </Button>
  );
}
