// The Launch section's script row as drawn (ScriptLaunchRow.tsx picks
// the scripts, measures how many fit and runs them): a pill per
// script, on one line, or wrapping when the scripts are the ones
// pinned to the row.
import type { ComponentProps, ReactNode, Ref } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface LaunchScript {
  name: string;
  command: string;
}

function idlePill(script: LaunchScript) {
  return <IdleScriptPill key={script.name} {...script} />;
}

export function ScriptLaunchRowView({
  scripts,
  pinned = false,
  renderPill = idlePill,
  containerRef,
  measurer,
}: {
  // The scripts to show: every pinned one, or the ones that fit.
  scripts: LaunchScript[];
  pinned?: boolean;
  // A live pill per script. An idle one, ready to run, when not given.
  renderPill?: (script: LaunchScript) => ReactNode;
  // The fitted row and the hidden copy it is measured by
  // (ScriptLaunchRow's FittedScriptRow).
  containerRef?: Ref<HTMLDivElement>;
  measurer?: ReactNode;
}) {
  if (pinned) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {scripts.map(renderPill)}
      </div>
    );
  }
  // No overflow-hidden on the row: the fit is measured, so there's nothing to
  // clip, and clipping would eat the pills' focus ring, which paints outside
  // the button box.
  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {scripts.map(renderPill)}
      {measurer}
    </div>
  );
}

// A pill as it sits before a run: its title says what it runs.
function IdleScriptPill({ name, command }: LaunchScript) {
  const actionLabel = `Run ${name}`;
  return (
    <ScriptPill
      name={name}
      busy={false}
      aria-label={actionLabel}
      title={`${actionLabel}\n${command}\n⌘click to view output`}
    />
  );
}

// Presentational half, shared by the visible row and the measurer so the two
// can't drift apart. Both icons render at the same size, so a running script
// occupies exactly the width it was measured at.
export function ScriptPill({
  name,
  busy,
  ...props
}: {
  name: string;
  busy: boolean;
} & ComponentProps<typeof Button>) {
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
