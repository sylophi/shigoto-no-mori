import { useLayoutEffect, useRef, useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import type { PullRequestStack } from "@shared/pullRequestStack";
import { describeMergeVerdict } from "@/lib/pullRequest";
import type {
  MergeMethod,
  PullRequestDetail,
  RepoMergeConfig,
  Worktree,
} from "@shigomori/contracts/schemas";
import { MergeBoxView } from "./MergeBoxView";
import { useMergeBox } from "./useMergeBox";

export function MergeBox({
  worktree,
  pr,
  repoConfig,
  lastMergeMethod,
  stack,
}: {
  worktree: Worktree;
  pr: PullRequestDetail;
  repoConfig: RepoMergeConfig | null;
  lastMergeMethod: MergeMethod | undefined;
  stack: PullRequestStack | null;
}) {
  const {
    merge,
    setDraft,
    disableAutoMerge,
    armed,
    trigger,
    primary,
    activeMethod,
    mode,
    status,
    disabled,
    others,
    blocked,
    label,
    landsStack,
    pendingLabel,
    reach,
    showReach,
    runMerge,
    pickMethod,
    pickReach,
    toggleDraft,
    runDisableAutoMerge,
  } = useMergeBox({ worktree, pr, repoConfig, lastMergeMethod, stack });
  const canMerge = primary !== null && activeMethod !== null;
  // A peer that takes no commands from here gets the status alone.
  const { canCommand } = useCommandAccess();
  const rowRef = useRef<HTMLDivElement>(null);
  const verdict = describeMergeVerdict(pr, status, mode === "armed");
  const reviewsSaid = verdict.by === "reviews";
  const compact = useCompactChips(rowRef, reviewsSaid, canMerge && canCommand);

  // The merge box's one status (or why there's no merge button, with
  // the checks beside it), then the reviews. Items of the row they sit
  // in, so a chip that doesn't fit wraps beside the buttons rather than
  // onto a line of its own.
  return (
    <MergeBoxView
      pr={pr}
      hasMethod={canMerge}
      verdict={verdict}
      compact={compact}
      rowRef={rowRef}
      merge={
        primary && activeMethod && canCommand
          ? {
              mode,
              label,
              pendingLabel,
              landsStack,
              blocked,
              disabled,
              pending: merge.isPending,
              armed,
              onMerge: () => trigger(() => runMerge(activeMethod)),
              others,
              onPickMethod: pickMethod,
              reach: showReach
                ? { value: reach, onPick: pickReach }
                : undefined,
              draftPending: setDraft.isPending,
              onToggleDraft: toggleDraft,
              disablePending: disableAutoMerge.isPending,
              onDisableAutoMerge: runDisableAutoMerge,
              error: merge.error?.message,
              disableError: disableAutoMerge.error?.message,
              draftError: setDraft.error?.message,
            }
          : null
      }
    />
  );
}

function useCompactChips(
  rowRef: React.RefObject<HTMLElement | null>,
  reviewsSaid: boolean,
  present: boolean,
): { reviews: boolean; status: boolean } {
  const [level, setLevel] = useState(0);
  const widths = useRef({ reviews: 0, status: 0 });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const gapOf = (el: Element) =>
      parseFloat(getComputedStyle(el).columnGap) || 0;
    const check = () => {
      const label = (key: "reviews" | "status") =>
        row.querySelector<HTMLElement>(`[data-${key}-label]`);
      for (const key of ["reviews", "status"] as const) {
        const el = label(key);
        // The words and the chip's gap before them.
        if (el?.parentElement) {
          widths.current[key] = el.scrollWidth + gapOf(el.parentElement);
        }
      }
      const reviews = reviewsSaid ? 0 : widths.current.reviews;
      const status = widths.current.status;
      const items = [...row.children] as HTMLElement[];
      // The row's width as if every word showed.
      const full =
        items.reduce((sum, el) => sum + el.offsetWidth, 0) +
        gapOf(row) * (items.length - 1) +
        (label("reviews") ? 0 : reviews) +
        (label("status") ? 0 : status);
      const room = row.clientWidth;
      setLevel(full <= room ? 0 : full - reviews <= room ? 1 : 2);
    };
    const resize = new ResizeObserver(check);
    const watch = () => {
      resize.disconnect();
      resize.observe(row);
      for (const child of row.children) resize.observe(child);
      check();
    };
    watch();
    // A chip that swaps its element (the checks arriving) or its words
    // resizes nothing already watched, and nor does a font loading.
    const mutations = new MutationObserver(watch);
    mutations.observe(row, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    void document.fonts.ready.then(check);
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [rowRef, reviewsSaid, present]);
  return { reviews: level >= 1, status: level >= 2 };
}
