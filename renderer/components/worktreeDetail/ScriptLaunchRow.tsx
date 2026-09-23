import { useLayoutEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocalGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { usePackageScriptSort } from "@/hooks/scripts/usePackageScriptSort";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { hasLocalHost } from "@/lib/localHost";
import type { Worktree } from "@shared/schemas";
import { sortEntries, type SortableEntry } from "./scripts/sortPackageScripts";

// Matches the `gap-2` on both the visible row and the measurer.
const GAP_PX = 8;

// Upper bound on what we're willing to lay out off-screen. A repo with 60
// scripts would otherwise render 60 hidden pills to measure the ~8 that can
// fit. The row runs the full pane width, so this is the shortcut budget
// rather than a fit bound; off-row scripts stay in the Scripts section.
const MAX_CANDIDATES = 16;

interface ScriptLaunchRowProps {
  worktree: Worktree;
  candidates: SortableEntry[];
}

// The scripts the row offers, empty while it has nothing to show (still
// loading, switched off in Settings, or no package.json scripts). Read by
// LaunchSection, which hands them down and decides whether to exist on them.
// `loading` is the scripts read still in flight with the row switched on.
export function useScriptLaunchCandidates(worktree: Worktree): {
  candidates: SortableEntry[];
  loading: boolean;
} {
  const { data: config } = useLocalGlobalConfig();
  const { data: pkg, isPending } = usePackageScripts(
    worktree.projectId,
    worktree.id,
  );
  const { data: sortMode = "frequent" } = usePackageScriptSort(
    worktree.projectId,
  );

  // The switch is this window's preference, so it reads this machine's
  // config even on a peer's page. A hostless client has no config to switch
  // it off in, so the row is on there.
  // Undefined config means the read is still in flight, which is NOT the same
  // as "on by default". Defaulting to on there flashes the row in and back
  // out for anyone who switched it off.
  const enabled = hasLocalHost
    ? config !== undefined && (config.launchScripts ?? true)
    : true;
  if (!enabled || !pkg)
    return { candidates: [], loading: enabled && isPending };
  return {
    candidates: sortEntries(
      Object.entries(pkg.scripts),
      sortMode,
      pkg.usage,
    ).slice(0, MAX_CANDIDATES),
    loading: false,
  };
}

// A second row in the Launch section: the top package.json scripts, in the
// same order the Scripts section shows them (the project's sort mode,
// most-used by default), trimmed to whatever fits on one line. Off-row
// scripts stay reachable in the Scripts section; this row is a shortcut,
// not a replacement, so it never wraps and never scrolls.
export function ScriptLaunchRow({
  worktree,
  candidates,
}: ScriptLaunchRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measurerRef = useRef<HTMLDivElement>(null);
  const [fitCount, setFitCount] = useState(0);
  // Re-measure when the scripts change, which can invalidate a count without
  // resizing anything the observer watches. That includes the row appearing
  // at all: it has no candidates while it's off, and the refs are null then,
  // so the effect can't measure.
  const namesKey = candidates.map((entry) => entry.name).join("\n");

  // The hidden measurer holds every candidate at its natural width; the
  // visible row renders the prefix of them that fits. Observing the measurer
  // too (not just the container) re-runs this when the mono font swaps in and
  // every pill changes width. Same trick as PullRequestIdentity.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const measurer = measurerRef.current;
    if (!container || !measurer) return;
    const check = () => {
      const available = container.getBoundingClientRect().width;
      const widths = Array.from(
        measurer.children,
        (child) => child.getBoundingClientRect().width,
      );
      const next = countThatFit(widths, available, GAP_PX);
      setFitCount((prev) => (prev === next ? prev : next));
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(container);
    observer.observe(measurer);
    return () => observer.disconnect();
  }, [namesKey]);

  if (candidates.length === 0) return null;

  // No overflow-hidden on the row: the fit is measured, so there's nothing to
  // clip, and clipping would eat the pills' focus ring, which paints outside
  // the button box.
  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {candidates.slice(0, fitCount).map((entry) => (
        <ScriptLaunchButton
          key={entry.name}
          worktree={worktree}
          name={entry.name}
          command={entry.command}
        />
      ))}

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
          ref={measurerRef}
          className="flex w-max items-center gap-2 whitespace-nowrap"
        >
          {candidates.map((entry) => (
            <ScriptPill key={entry.name} name={entry.name} busy={false} />
          ))}
        </div>
      </div>
    </div>
  );
}

// How many leading pills fit in `available`, counting the gap between them.
function countThatFit(
  widths: number[],
  available: number,
  gap: number,
): number {
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const next = used + (count > 0 ? gap : 0) + width;
    // Sub-pixel slack: a fractional overshoot the browser rounds away
    // shouldn't cost a pill.
    if (next > available + 0.5) break;
    used = next;
    count += 1;
  }
  return count;
}

function ScriptLaunchButton({
  worktree,
  name,
  command,
}: {
  worktree: Worktree;
  name: string;
  command: string;
}) {
  const { toScript } = useWorktreeNav();
  const slot = { kind: "package", name } as const;
  const { state, busy, canRun, disabledReason, start, stop } = useScriptRunner(
    worktree,
    slot,
  );
  const actionLabel = busy ? `Stop ${name}` : `Run ${name}`;

  // Cmd-click detours to the script's console instead of toggling the
  // run. Cmd is the modifier the tooltip advertises.
  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey) {
      toScript(worktree.projectId, worktree.id, slot);
      return;
    }
    (busy ? stop : start)();
  };

  return (
    <ScriptPill
      name={name}
      busy={busy}
      disabled={state.cancelling || !canRun}
      onClick={handleClick}
      aria-label={actionLabel}
      title={
        disabledReason ?? `${actionLabel}\n${command}\n⌘click to view output`
      }
    />
  );
}

// Presentational half, shared by the visible row and the measurer so the two
// can't drift apart. Both icons render at the same size, so a running script
// occupies exactly the width it was measured at.
function ScriptPill({
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
