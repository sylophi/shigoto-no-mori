// A transplant or a mirror queued for a device that was offline, on the
// worktree it moves (the source): a footer verb in the transfers' place
// while it waits, runs or has failed, and the dialog it opens, which
// says what will happen and lets it go. The container
// (worktreeDetail/QueuedMoveAction.tsx) reads the queue.
import { AlertTriangle, Clock, LoaderCircle } from "lucide-react";
import type {
  SyncQueuedMove,
  SyncSourceFate,
} from "@shigomori/contracts/modules/sync";
import { Button } from "../../primitives/button.tsx";
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "../../primitives/dialog.tsx";
import { InlineError } from "../../primitives/inline-error.tsx";
import {
  type StatusTone,
  TONE_PILL,
  TONE_TEXT,
} from "../../primitives/status-dot.tsx";
import { capitalized } from "@shigomori/contracts/words";
import { cn } from "../../lib/utils.ts";
import { FooterActionButtonView } from "./FooterActionButtonView.tsx";
import { LABEL_RANK } from "./FooterVerbView.tsx";

// A queued move until it went through: what went through is the toast's.
export type PendingQueuedMove = SyncQueuedMove & {
  readonly state: Exclude<SyncQueuedMove["state"], { status: "done" }>;
};

type Shown = PendingQueuedMove["state"]["status"];

const TONE: Record<Shown, StatusTone> = {
  waiting: "sky",
  running: "sky",
  failed: "rose",
};

const ICON = { waiting: Clock, running: LoaderCircle, failed: AlertTriangle };

function labelOf(
  move: PendingQueuedMove,
  device: string,
  shown: Shown,
): string {
  switch (shown) {
    case "waiting":
      return `Waiting for ${device}`;
    case "running":
      return move.kind === "mirror" ? "Starting mirror" : "Transplanting";
    case "failed":
      return `${capitalized(move.kind)} failed`;
  }
}

// What it does once it runs, in a sentence.
function plan(move: PendingQueuedMove, device: string): string {
  const send = move.direction === "send";
  if (move.kind === "mirror") {
    return send
      ? `A live copy of this worktree starts on ${device}, kept in step both ways.`
      : `A live copy of this worktree starts on this device, kept in step both ways.`;
  }
  const where = send ? `to ${device}` : `here from ${device}`;
  return `This worktree moves ${where}. ${fateWords(move.source ?? "keep", send ? "this device" : device)}`;
}

function fateWords(fate: SyncSourceFate, source: string): string {
  switch (fate) {
    case "keep":
      return `The copy on ${source} stays.`;
    case "shelve":
      return `The copy on ${source} is shelved after.`;
    case "teardown":
      return `The copy on ${source} is torn down after, unless it changed meanwhile.`;
  }
}

export function QueuedMoveButtonView({
  move,
  device,
  onOpen,
}: {
  move: PendingQueuedMove;
  // The other device's name.
  device: string;
  onOpen: () => void;
}) {
  const shown = move.state.status;
  const Icon = ICON[shown];
  return (
    <FooterActionButtonView
      rank={LABEL_RANK.mirror}
      icon={
        <Icon
          className={cn(
            TONE_TEXT[TONE[shown]],
            shown === "running" && "animate-spin",
          )}
        />
      }
      label={labelOf(move, device, shown)}
      tip={
        shown === "waiting"
          ? `${capitalized(move.kind)} queued until ${device} is back online`
          : undefined
      }
      onClick={onOpen}
    />
  );
}

export function QueuedMoveDialogView({
  move,
  device,
  pending,
  onCancel,
  onRetry,
  onClose,
}: {
  move: PendingQueuedMove;
  device: string;
  // A cancel or a retry under way.
  pending: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const shown = move.state.status;
  const noun = capitalized(move.kind);
  const toward = move.direction === "send" ? `to ${device}` : `from ${device}`;
  const title = {
    waiting: `${noun} waiting for ${device}`,
    running: `${noun} ${toward} running`,
    failed: `${noun} ${toward} failed`,
  }[shown];
  return (
    <>
      <DialogHeader
        tint={TONE_PILL[TONE[shown]]}
        icon={ICON[shown]}
        spin={shown === "running"}
        title={title}
        onClose={onClose}
      >
        {move.branch}
      </DialogHeader>
      <DialogBody>
        <div className="space-y-3 text-sm">
          {move.state.status === "failed" ? (
            <InlineError
              message={move.state.error}
              title={title}
              multiline
              className="text-sm text-destructive"
            />
          ) : (
            <p>
              {shown === "waiting"
                ? `${device} is offline. The ${move.kind} starts on its own once it's back, as long as the app is running here.`
                : `${device} is back, and the ${move.kind} is under way.`}
            </p>
          )}
          <p className="text-muted-foreground">{plan(move, device)}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        {shown === "failed" ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={pending}
              onClick={onCancel}
            >
              Dismiss
            </Button>
            <Button size="sm" disabled={pending} onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel {move.kind}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
