// Step 3 of the transplant (TransplantFinishView.tsx): what happens to
// the copy still on the source device, and the run of that choice.
import { useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  SyncPullWorktreeResult,
  SyncTeardownSourceResult,
} from "@shigomori/contracts/modules/sync";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { keptSourceReason } from "@/hooks/remote/useMoveWorktree";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useSetShelved } from "@/hooks/worktrees/useWorktreeMutations";
import { LandedPath } from "../flow/FlowChrome";
import { type Landing, LANDS_HERE } from "../flow/pullSteps";
import {
  type SourceChoice,
  TransplantFinishView,
} from "./TransplantFinishView";

export function TransplantFinish({
  result,
  leftOutCount,
  worktree,
  project,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing = LANDS_HERE,
  teardown,
  onClose,
  onOpen,
}: {
  result: SyncPullWorktreeResult;
  // What the leave-out rule kept on the source once the files step
  // ran: 0 for Nothing, the picked count for its exceptions, null
  // under Gitignored, which left every ignored file there (the read
  // below counts them) or all but the brought ones (left uncounted).
  leftOutCount: number | null;
  // The SOURCE worktree and project, on the device this page is scoped
  // to. The landed pair is in `result`.
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
  // The device it landed on, and the words for that (pullSteps.ts).
  thisDeviceLabel: string;
  landing?: Landing;
  // The source's guarded teardown (sync:teardownSource), on the peer
  // after a pull, on this device after a send.
  teardown: UseMutationResult<SyncTeardownSourceResult, Error, void>;
  onClose: () => void;
  // Leave for the landed worktree's own page.
  onOpen: () => void;
}) {
  const setShelved = useSetShelved();
  const filesCrossed = result.files?.crossed === true;
  // Only the teardown card reads it, and only when the ignored files
  // stayed on the source: a peer round trip and a checkout walk that
  // the default transplant (files across) never needs.
  const { data: ignored } = useWorktreeIgnoredPaths(project.id, worktree.id, {
    enabled: !filesCrossed,
  });
  // What a teardown would take with the source: every ignored file
  // when none crossed, otherwise the ones the rule left out.
  const staying = filesCrossed ? leftOutCount : (ignored?.total ?? null);
  const {
    armed,
    trigger,
    reset: disarm,
  } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // An unapplied capture means the uncommitted work exists only on the
  // source, so tearing it down is off the table (the handler refuses
  // it too. This is the reason, spelled out).
  const stranded = result.captured && !result.dirtyApplied;
  // Ignored files the files step meant to bring and could not are only
  // on the source too: tear down stays on offer, but is not the default.
  const filesFailed = result.files !== undefined && !filesCrossed;
  const [choice, setChoiceState] = useState<SourceChoice>(
    stranded || filesFailed ? "keep" : "teardown",
  );
  const choose = (next: SourceChoice) => {
    // Neither an armed confirm nor a stale failure carries over from
    // one choice to another.
    disarm();
    setShelved.reset();
    teardown.reset();
    setChoiceState(next);
  };
  const pending = setShelved.isPending || teardown.isPending;
  const error = setShelved.error ?? teardown.error;
  // A teardown that resolved without removing the source: the dialog
  // stays, with the reason, so the user can fix it and try again or
  // pick another fate.
  const kept =
    teardown.data !== undefined && !teardown.data.sourceRemoved
      ? (keptSourceReason(teardown.data.sourceError) ??
        "its teardown was refused.")
      : null;
  const branch = result.worktree.branch;
  // The landed worktree's villager, when it has one, says the news.
  const say = useWorktreeSuccessToast();

  // Each fate ends on the landed worktree's page, except a teardown
  // the source refused.
  const finish = async () => {
    try {
      if (choice === "shelve") {
        await setShelved.mutateAsync({
          projectId: project.id,
          worktreeId: worktree.id,
          shelved: true,
        });
        say(result.worktree, `Transplanted ${branch} ${landing.to}`, {
          description: `The copy on ${sourceDeviceLabel} is shelved.`,
        });
      } else if (choice === "teardown") {
        const outcome = await teardown.mutateAsync();
        if (!outcome.sourceRemoved) return;
        say(result.worktree, `Transplanted ${branch} ${landing.to}`, {
          description: `The copy on ${sourceDeviceLabel} was torn down.`,
        });
      } else {
        say(
          result.worktree,
          landing.onPeer
            ? `Sent ${branch} ${landing.to}`
            : `Brought ${branch} here`,
          {
            description: `The copy on ${sourceDeviceLabel} is kept.`,
          },
        );
      }
      onOpen();
    } catch {
      // Reported inline below (and by the hook's own error title).
    }
  };

  const onFinish = () => {
    if (choice === "teardown") trigger(() => void finish());
    else void finish();
  };

  return (
    <TransplantFinishView
      result={result}
      path={<LandedPath path={result.worktree.path} />}
      sourceDeviceLabel={sourceDeviceLabel}
      thisDeviceLabel={thisDeviceLabel}
      landing={landing}
      choice={choice}
      onChoose={choose}
      staying={staying}
      error={error}
      kept={kept}
      pending={pending}
      armed={armed}
      onClose={onClose}
      onOpen={onOpen}
      onFinish={onFinish}
    />
  );
}
