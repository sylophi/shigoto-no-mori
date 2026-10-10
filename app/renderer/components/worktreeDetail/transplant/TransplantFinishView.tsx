// Step 3 of the transplant, drawn (TransplantFinish.tsx binds it): proof it landed, then the one decision the
// old one-shot transplant made for the user -- what happens to the
// copy still on the source device. Keep leaves it, shelve hides it
// (the peer's ordinary setShelved, files kept), tear down runs the
// same guarded teardown the one-shot orchestrator did
// (sync:teardownSource). Tear down is preselected: the work is here
// now, and a transplant is a move, not a copy.
// A transplant to a peer ends on the same step with the two machines
// swapped: the copy landed there and the source is this device's own
// worktree, so its words say "there" and its teardown is the local one
// the dialog hands in.
import { ArrowRight, Check } from "lucide-react";
import type { ReactNode } from "react";
import type { SyncPullWorktreeResult } from "@shigomori/contracts/modules/sync";
import {
  errorMessageOf,
  isCommandRefusedError,
} from "@shigomori/contracts/errors";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { Chip } from "@shigomori/ui/primitives/chip-button.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { InlineError } from "@shigomori/ui/primitives/inline-error.tsx";
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { FlowBodyView, FlowFooterView } from "../flow/FlowChromeView";
import type { Landing } from "../flow/pullSteps";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

export type SourceChoice = "keep" | "shelve" | "teardown";

// The three fates of the source copy, in card order. Tear down is
// preselected when the work landed whole: the worktree moved, and a
// copy left behind is what the move was meant not to leave. With the
// changes stranded on the source, tear down is off and keep is the
// default instead. With ignored files the files step could not bring,
// keep is the default too, and tear down stays on offer.
// The teardown card also counts the ignored files that die with the
// source (the review step listed them): they never travelled, and
// nothing in the teardown itself refuses over them, so this is the
// last place the user hears it before the confirm.
const CHOICES: {
  key: SourceChoice;
  title: string;
  // ignored: the count still only on the source (0 once the pull's
  // files step brought them here). null: the read has not landed or
  // was refused, which is not the same as none.
  body: (source: string, ignored: number | null) => string;
}[] = [
  {
    key: "keep",
    title: "Keep it",
    body: () => "Both devices keep a checkout of this branch.",
  },
  {
    key: "shelve",
    title: "Shelve it",
    body: () => "Hidden from its sidebar, files kept. Unshelve any time.",
  },
  {
    key: "teardown",
    title: "Tear it down",
    body: (source, ignored) =>
      `Runs teardown and removes it from ${source} for good${
        ignored === null
          ? ", along with any ignored files that stayed there"
          : ignored > 0
            ? `, with ${pluralize(ignored, "ignored file")} that stayed there`
            : ""
      }.`,
  },
];

const FINISH_LABEL: Record<SourceChoice, string> = {
  keep: "Keep and finish",
  shelve: "Shelve and finish",
  teardown: "Tear down and finish",
};

export function TransplantFinishView({
  result,
  path,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing,
  choice,
  onChoose,
  staying,
  error,
  kept,
  pending,
  armed,
  onClose,
  onOpen,
  onFinish,
}: {
  result: SyncPullWorktreeResult;
  // Where it landed (LandedPath).
  path: ReactNode;
  sourceDeviceLabel: string;
  // The device it landed on, and the words for that (pullSteps.ts).
  thisDeviceLabel: string;
  landing: Landing;
  choice: SourceChoice;
  onChoose: (choice: SourceChoice) => void;
  // The ignored files a teardown would take with the source, null
  // when that is not known.
  staying: number | null;
  error: Error | null;
  // Why a teardown left the source, or null.
  kept: string | null;
  pending: boolean;
  armed: boolean;
  onClose: () => void;
  // Leave for the landed worktree's own page.
  onOpen: () => void;
  onFinish: () => void;
}) {
  const { here } = landing;
  const filesCrossed = result.files?.crossed === true;
  // An unapplied capture means the uncommitted work exists only on the
  // source, so tearing it down is off the table.
  const stranded = result.captured && !result.dirtyApplied;
  const branch = result.worktree.branch;
  return (
    <>
      <FlowBodyView>
        <div className="flex flex-col gap-5">
          <section className="space-y-2">
            <SectionHeading>Ready on {thisDeviceLabel}</SectionHeading>
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-500/10 p-3">
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-background"
              >
                <Check className="size-4" />
              </span>
              <div className="min-w-0 flex-1 basis-64 space-y-1.5">
                <SimpleTooltip whenTruncated tip={branch}>
                  <p className="truncate font-mono text-sm font-semibold">
                    {branch}
                  </p>
                </SimpleTooltip>
                {path}
                <div className="flex flex-wrap gap-1.5">
                  {result.captured ? (
                    result.dirtyApplied ? (
                      <Chip>changes re-applied</Chip>
                    ) : (
                      <Chip className="text-amber-700 dark:text-amber-300">
                        changes stayed on {sourceDeviceLabel}
                      </Chip>
                    )
                  ) : (
                    <Chip>clean tree</Chip>
                  )}
                  {result.files !== undefined &&
                    (result.files.crossed ? (
                      result.files.conflicts > 0 ? (
                        <Chip className="text-amber-700 dark:text-amber-300">
                          ignored files {here},{" "}
                          {pluralize(result.files.conflicts, "path")} kept{" "}
                          {landing.onPeer ? "that" : "this"} side's version
                        </Chip>
                      ) : (
                        <Chip>ignored files {here}</Chip>
                      )
                    ) : (
                      <Chip className="text-amber-700 dark:text-amber-300">
                        ignored files stayed on {sourceDeviceLabel}
                      </Chip>
                    ))}
                </div>
              </div>
              <Button size="sm" onClick={onOpen} className="shrink-0">
                Open {here}
                <ArrowRight />
              </Button>
            </div>
            {stranded && (
              <p className="text-xs text-muted-foreground">
                The uncommitted changes could not be applied {here}. They are
                still on {sourceDeviceLabel}, and the capture is parked {here}{" "}
                for <span className="font-mono">sm dirty apply</span>.
              </p>
            )}
            {result.files !== undefined && !filesCrossed && (
              <p className="text-xs text-muted-foreground">
                The ignored files could not be brought over
                {result.files.error ? `: ${result.files.error}` : ""}. They are
                still on {sourceDeviceLabel}.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <SectionHeading>
              The copy still on {sourceDeviceLabel}
            </SectionHeading>
            <div
              role="radiogroup"
              aria-label={`What to do with the copy on ${sourceDeviceLabel}`}
              className="grid gap-2 sm:grid-cols-3"
            >
              {CHOICES.map((entry) => {
                const off = entry.key === "teardown" && stranded;
                return (
                  <ChoiceCard
                    key={entry.key}
                    selected={choice === entry.key}
                    onSelect={() => onChoose(entry.key)}
                    disabled={off}
                    title={entry.title}
                    body={
                      off
                        ? "Off while the changes only exist there."
                        : entry.body(sourceDeviceLabel, staying)
                    }
                  />
                );
              })}
            </div>
          </section>

          {error !== null ? (
            isCommandRefusedError(error) ? (
              <p className="text-xs text-destructive select-text">
                {peerReadOnlyNote(sourceDeviceLabel)}
              </p>
            ) : (
              <InlineError
                message={errorMessageOf(error)}
                title={`Couldn't finish on ${sourceDeviceLabel}`}
                multiline
                className="text-xs text-destructive"
              />
            )
          ) : (
            kept !== null && (
              <InlineError
                message={`The copy on ${sourceDeviceLabel} stayed: ${kept}`}
                title={`Couldn't tear down the copy on ${sourceDeviceLabel}`}
                multiline
                className="text-xs text-destructive"
              />
            )
          )}
        </div>
      </FlowBodyView>

      <FlowFooterView
        note={`You can change this later from the worktree's page on ${sourceDeviceLabel}.`}
      >
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          Decide later
        </Button>
        <Button
          size="sm"
          variant={choice === "teardown" ? "destructive" : "default"}
          aria-pressed={choice === "teardown" ? armed : undefined}
          disabled={pending}
          onClick={onFinish}
        >
          {pending
            ? "Finishing…"
            : armed && choice === "teardown"
              ? "Click again to confirm"
              : FINISH_LABEL[choice]}
        </Button>
      </FlowFooterView>
    </>
  );
}

function ChoiceCard({
  selected,
  disabled = false,
  onSelect,
  title,
  body,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      data-slot="choice-card"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3 text-left text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        selected
          ? "border-primary/40 bg-accent text-accent-foreground"
          : "border-border bg-card hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50 hover:bg-card",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full",
            selected
              ? "bg-primary text-primary-foreground"
              : "bg-muted-foreground/20",
          )}
        >
          {selected && <Check className="size-2.5" />}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </span>
      <span className={cn(!selected && "text-muted-foreground")}>{body}</span>
    </button>
  );
}
