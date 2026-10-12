// The guide: the question Help → Ask How… takes (AskHow.tsx binds it),
// then in the window it drives a band over the page saying whose agent
// it is, with Stop, and a ring around what the agent points at with its
// sentence beside it (GuideBand.tsx and GuideCallout.tsx bind them).
import { Compass, Loader2, Square } from "lucide-react";
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import {
  TONE_FILL,
  TONE_MARK,
  TONE_PILL,
} from "../../primitives/status-dot.tsx";
import { cn, dragRegion } from "../../lib/utils.ts";
import {
  FlowFooterView,
  FlowHeaderView,
} from "../worktreeDetail/flow/FlowChromeView.tsx";
import { AppIconView } from "../shared/LauncherIconView.tsx";

// An agent the guide can open.
export interface GuideHarnessOption {
  id: GuideHarness;
  label: string;
}

// The question, and which agent takes it when more than one is set up
// here. Up while the agent's terminal opens.
export function AskHowDialogView({
  question,
  onQuestionChange,
  harnesses,
  harness,
  onHarnessChange,
  asking,
  onAsk,
  onCancel,
}: {
  question: string;
  onQuestionChange: (question: string) => void;
  // Undefined until read.
  harnesses: readonly GuideHarnessOption[] | undefined;
  // The one picked, else the first.
  harness: GuideHarness | null;
  onHarnessChange: (harness: GuideHarness) => void;
  // The agent opening, if any.
  asking: GuideHarness | null;
  onAsk: (harness: GuideHarness) => void;
  onCancel: () => void;
}) {
  const picked =
    harnesses?.find((option) => option.id === harness) ?? harnesses?.[0];
  const none = harnesses?.length === 0;
  const ready = picked !== undefined && question.trim() !== "" && !asking;
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onAsk(picked.id);
      }}
    >
      <FlowHeaderView
        tint={TONE_PILL.sky}
        icon={Compass}
        title="Ask how"
        onClose={onCancel}
      >
        <p>
          {none
            ? "The guide opens Claude Code or Codex, and neither is installed."
            : "Your agent opens in your terminal and shows you here."}
        </p>
      </FlowHeaderView>
      <div className="flex flex-col items-start gap-3 px-5 pb-5">
        <Input
          aria-label="Question"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog is for this field
          autoFocus
          placeholder="How do I mirror a worktree to my other Mac?"
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          disabled={asking !== null || none}
          className="h-9 w-full px-3 text-sm"
        />
        {picked && harnesses && harnesses.length > 1 && (
          <SegmentedControl
            aria-label="Agent"
            value={picked.id}
            onChange={onHarnessChange}
            disabled={asking !== null}
            options={harnesses.map((option) => ({
              value: option.id,
              label: (
                <>
                  <AppIconView appId={option.id} className="size-3.5" />
                  {option.label}
                </>
              ),
            }))}
          />
        )}
      </div>
      <FlowFooterView>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {picked && (
          <Button type="submit" size="sm" disabled={!ready}>
            {asking && <Loader2 aria-hidden className="animate-spin" />}
            Ask {picked.label}
          </Button>
        )}
      </FlowFooterView>
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
    // At the top of the window, so the title bar drags by it. Its wash
    // sits on the page's background, not the window's canvas.
    <div className="shrink-0 bg-background" style={dragRegion("drag")}>
      <div
        className={cn(
          "flex h-9 items-center gap-2 px-4 text-xs text-muted-foreground",
          TONE_FILL.sky,
        )}
      >
        <Compass
          aria-hidden
          className={cn("size-3.5 shrink-0", TONE_MARK.sky)}
        />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-foreground">{harnessLabel}</span>{" "}
          is showing you around
        </p>
        <Button
          size="xs"
          variant="outline"
          style={dragRegion("no-drag")}
          onClick={onStop}
        >
          <Square aria-hidden className="size-2.5 fill-current" />
          Stop
        </Button>
      </div>
    </div>
  );
}

// Where the target is, from the window's corner, its corner's radius,
// and where its sentence goes: under it, or over it when there is more
// room above. The view is laid over the whole window (AppShellView's
// overlays).
export interface GuideCalloutPlace {
  ring: { x: number; y: number; width: number; height: number };
  // The target's own (its computed border-radius), so the ring follows
  // a pill as it does a card.
  radius: string;
  left: number;
  top?: number;
  bottom?: number;
}

// The gap between a target and its ring, and how far in from the
// sentence's corners its tail stays.
const RING_GAP = 4;
const TAIL_INSET = 16;

export function GuideCalloutView({
  place,
  say,
}: {
  place: GuideCalloutPlace;
  say: string;
}) {
  const { ring } = place;
  const below = place.top !== undefined;
  // The tail under the target's middle, as far as the sentence reaches.
  const tail = Math.max(TAIL_INSET, ring.x + ring.width / 2 - place.left);
  return (
    // Over the menus and dialogs (z-50), which the guide points into.
    <div className="pointer-events-none absolute inset-0 z-[60]">
      <div
        data-slot="guide-ring"
        className="absolute shadow-[0_0_0_6px_color-mix(in_oklab,var(--color-sky-500)_20%,transparent)] ring-2 ring-sky-500 transition-all duration-150 motion-reduce:transition-none"
        style={{
          left: ring.x - RING_GAP,
          top: ring.y - RING_GAP,
          width: ring.width + RING_GAP * 2,
          height: ring.height + RING_GAP * 2,
          borderRadius: `calc(${place.radius} + ${RING_GAP}px)`,
        }}
      />
      <div
        role="status"
        data-slot="guide-callout-box"
        className="absolute flex w-max max-w-72 gap-2 rounded-xl bg-popover px-3.5 py-2.5 text-xs leading-relaxed text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: place.left, top: place.top, bottom: place.bottom }}
      >
        <span
          aria-hidden
          className={cn(
            "absolute size-2.5 rotate-45 bg-popover",
            below ? "-top-1" : "-bottom-1",
          )}
          style={{ left: `min(${tail}px, calc(100% - ${TAIL_INSET}px))` }}
        />
        <Compass
          aria-hidden
          className={cn("relative mt-0.5 size-3.5 shrink-0", TONE_MARK.sky)}
        />
        <p className="relative">{say}</p>
      </div>
    </div>
  );
}
