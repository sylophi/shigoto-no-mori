// The guide: the question Help → Ask How… takes (AskHow.tsx binds it),
// then in the window it drives a band over the page saying whose agent
// it is, with Stop, and a ring around what the agent points at with its
// sentence beside it (GuideBand.tsx and GuideCallout.tsx bind them).
import { Compass, Loader2 } from "lucide-react";
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { TONE_MARK, TONE_PILL } from "../../primitives/status-dot.tsx";
import { cn, dragRegion } from "../../lib/utils.ts";

// An agent the guide can open.
export interface GuideHarnessOption {
  id: GuideHarness;
  label: string;
}

// The question, and an Ask for each agent set up here, the first one
// ↩. Up while the agent's terminal opens.
export function AskHowDialogView({
  question,
  onQuestionChange,
  harnesses,
  asking,
  onAsk,
  onCancel,
}: {
  question: string;
  onQuestionChange: (question: string) => void;
  // Undefined until read.
  harnesses: readonly GuideHarnessOption[] | undefined;
  // The agent opening, if any.
  asking: GuideHarness | null;
  onAsk: (harness: GuideHarness) => void;
  onCancel: () => void;
}) {
  const [first, ...rest] = harnesses ?? [];
  const ready = question.trim() !== "" && asking === null;
  const ask = (harness: GuideHarnessOption) => (
    <>
      {asking === harness.id && (
        <Loader2 aria-hidden className="animate-spin" />
      )}
      Ask {harness.label}
    </>
  );
  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (first && ready) onAsk(first.id);
      }}
    >
      <h2 className="text-base font-semibold">Ask how</h2>
      <Input
        aria-label="Question"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog is for this field
        autoFocus
        placeholder="How do I mirror a worktree to my other Mac?"
        value={question}
        onChange={(e) => onQuestionChange(e.target.value)}
        disabled={asking !== null || harnesses?.length === 0}
        className="h-9 px-3 text-sm"
      />
      {harnesses?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The guide opens Claude Code or Codex, and neither is installed.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {rest.map((harness) => (
          <Button
            key={harness.id}
            type="button"
            variant="outline"
            size="sm"
            disabled={!ready}
            onClick={() => onAsk(harness.id)}
          >
            {ask(harness)}
          </Button>
        ))}
        {first && (
          <Button type="submit" size="sm" disabled={!ready}>
            {ask(first)}
          </Button>
        )}
      </div>
    </form>
  );
}

export function GuideBandView({
  harnessLabel,
  onStop,
}: {
  harnessLabel: string;
  onStop: () => void;
}) {
  return (
    // At the top of the window, so the title bar drags by it.
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 px-4 text-xs",
        TONE_PILL.sky,
      )}
      style={dragRegion("drag")}
    >
      <Compass aria-hidden className={cn("size-3.5", TONE_MARK.sky)} />
      <span className="min-w-0 flex-1 truncate">
        {harnessLabel} is showing you around
      </span>
      <Button
        size="xs"
        variant="ghost"
        style={dragRegion("no-drag")}
        onClick={onStop}
      >
        Stop
      </Button>
    </div>
  );
}

// Where the target is, from the window's corner, and where its sentence
// goes: under it, or over it when there is more room above. The view is
// laid over the whole window (AppShellView's overlays).
export interface GuideCalloutPlace {
  ring: { x: number; y: number; width: number; height: number };
  left: number;
  top?: number;
  bottom?: number;
}

// The gap between a target and its ring, and between the ring and the
// sentence.
const RING_GAP = 4;

export function GuideCalloutView({
  place,
  say,
}: {
  place: GuideCalloutPlace;
  say: string;
}) {
  const { ring } = place;
  return (
    // Over the menus and dialogs (z-50), which the guide points into.
    <div className="pointer-events-none absolute inset-0 z-[60]">
      <div
        data-slot="guide-ring"
        className="absolute rounded-lg ring-2 ring-sky-500 transition-all duration-150 motion-reduce:transition-none"
        style={{
          left: ring.x - RING_GAP,
          top: ring.y - RING_GAP,
          width: ring.width + RING_GAP * 2,
          height: ring.height + RING_GAP * 2,
        }}
      />
      <div
        role="status"
        data-slot="guide-callout-box"
        className="absolute w-max max-w-72 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: place.left, top: place.top, bottom: place.bottom }}
      >
        {say}
      </div>
    </div>
  );
}
