import type { ReactNode } from "react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { Checkbox } from "@shigomori/ui/primitives/checkbox.tsx";
import { ToggleRowView } from "@shigomori/ui/views/shared/ToggleRowView.tsx";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { ErrorBanner } from "@shigomori/ui/primitives/error-banner.tsx";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@shigomori/ui/primitives/segmented-control.tsx";
import { PAGE_BODY } from "@shigomori/ui/views/shared/PageShellView.tsx";
import {
  sanitizeBranchName,
  sanitizeWorktreeNameInput,
} from "@shared/git/branches";
import { cn } from "@shigomori/ui/lib/utils.ts";

export type NewWorktreeMode = "branch-from" | "checkout" | "pull-request";

// Where a PR checkout's folder name comes from. "pr" is the numbered
// name, "branch" is the PR's head ref, "custom" hands the field over.
export type PrFolderSource = "pr" | "branch" | "custom";

// Branch leads: it's what the folder starts on, and a control whose
// default sits in the middle reads as if something was already changed.
const PR_FOLDER_OPTIONS = [
  { value: "branch", label: "Branch" },
  { value: "pr", label: "PR" },
  { value: "custom", label: "Custom" },
] as const satisfies readonly SegmentedOption<PrFolderSource>[];

// What the destination line leads with, per mode. The device, when there
// is a choice of one, is spliced in after this: "... checked out on
// Thinkpad into /home/...".
const MODE_DEST_LEAD: Record<NewWorktreeMode, string> = {
  "branch-from": "A new branch created off the source. Checked out",
  checkout: "Check out the source branch",
  "pull-request": "Check out the pull request's head",
};

const TEXT_INPUT_CLASS = "w-full px-3 py-2 font-mono text-sm";

// The page body the form sits in.
export function NewWorktreeBodyView({ children }: { children: ReactNode }) {
  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-7">{children}</div>
    </div>
  );
}

// The new-worktree form, drawn (NewWorktree.tsx binds it to the scoped
// device's branches, pull requests and worktrees, and runs the create).
export function NewWorktreeFormView({
  mode,
  onMode,
  prOptionOff,
  busy,
  sourcePicker,
  deviceLabel,
  base,
  checkoutBranch,
  baseHolder,
  prSource,
  branchName,
  onBranchName,
  branchTaken,
  useBranchAsFolder,
  prFolderFrom,
  onPrFolder,
  onUseSourceName,
  worktreeName,
  onWorktreeName,
  folderName,
  folderPlaceholder,
  folderTaken,
  folderSourceRaw,
  destPath,
  villager,
  cloneFiles,
  onCloneFiles,
  errorMessage,
  canSubmit,
  onSubmit,
  onCancel,
}: {
  mode: NewWorktreeMode;
  onMode: (mode: NewWorktreeMode) => void;
  // Why the pull request source can't be offered here, while it isn't
  // the one picked.
  prOptionOff: string | undefined;
  busy: boolean;
  // The source branch's picker (BranchCombobox).
  sourcePicker: ReactNode;
  // The device to name in the copy, when the page offers a choice.
  deviceLabel: string | undefined;
  base: string;
  // The branch a checkout lands on: a remote ref's local branch.
  checkoutBranch: string;
  // The worktree already holding the source a checkout would land on.
  baseHolder: string | undefined;
  // The pull request picker (PullRequestSourceView).
  prSource: ReactNode;
  branchName: string;
  onBranchName: (name: string) => void;
  branchTaken: boolean;
  useBranchAsFolder: boolean;
  prFolderFrom: "pr" | "branch";
  onPrFolder: (source: PrFolderSource) => void;
  onUseSourceName: (use: boolean) => void;
  worktreeName: string;
  onWorktreeName: (name: string) => void;
  folderName: string;
  folderPlaceholder: string;
  folderTaken: boolean;
  // What the folder name was made from, when it sanitizes to nothing.
  folderSourceRaw: string;
  // Where it lands, the folder included.
  destPath: string;
  // A villager moving in, for a folder named after one.
  villager: ReactNode;
  cloneFiles: boolean;
  onCloneFiles: (clone: boolean) => void;
  errorMessage: string | null;
  canSubmit: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const prMode = mode === "pull-request";
  const folderUnusable = folderSourceRaw.length > 0 && folderName.length === 0;
  const destLead = MODE_DEST_LEAD[mode];
  const destTrail =
    mode === "checkout"
      ? ". Branches already checked out in another worktree are hidden."
      : ".";

  return (
    <form
      className="flex flex-col gap-7"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {/* First, and outside the sections it governs: the pull request
        mode hides the source field, and a toggle that moves out from
        under the cursor as it's clicked is worse than the gap. The
        wrapper keeps the track hugging its options, since a bare flex
        child would stretch to the form's width. */}
      <div className="space-y-2">
        <SegmentedControl
          aria-label="Worktree source mode"
          value={mode}
          onChange={onMode}
          // Pull request leads: it's the source the form opens on, and the
          // selected segment should be the one your eye lands on first.
          // It stays in place when unavailable rather than dropping out,
          // since segments that reshuffle once the availability check
          // lands would move out from under the cursor.
          options={[
            {
              value: "pull-request",
              label: "From pull request",
              disabled: prOptionOff !== undefined,
              tip: prOptionOff,
            },
            { value: "branch-from", label: "Branch from source" },
            { value: "checkout", label: "Check out source" },
          ]}
          disabled={busy}
        />
      </div>

      {!prMode && (
        <div className="space-y-2">
          <label htmlFor="branch-base" className="block text-sm font-medium">
            Source
          </label>
          {sourcePicker}
          {deviceLabel && (
            <p className="text-xs text-muted-foreground">
              Branches are read from {deviceLabel}&apos;s checkout.
            </p>
          )}
          {baseHolder && (
            <p className="text-xs text-destructive">
              <span className="font-mono">{base}</span>
              {checkoutBranch !== base && (
                <>
                  {" "}
                  lands on <span className="font-mono">{checkoutBranch}</span>,
                  which
                </>
              )}{" "}
              is already checked out in {baseHolder}.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {prMode ? (
          prSource
        ) : (
          <>
            <label htmlFor="branch-name" className="block text-sm font-medium">
              Branch name
            </label>
            <Input
              id="branch-name"
              type="text"
              value={mode === "checkout" ? checkoutBranch : branchName}
              onChange={(e) => onBranchName(sanitizeBranchName(e.target.value))}
              placeholder="feat/new-thing"
              disabled={busy || mode === "checkout"}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- focused subpage
              autoFocus
              className={TEXT_INPUT_CLASS}
            />
            {branchTaken && (
              <p className="text-xs text-destructive">
                A branch named <span className="font-mono">{branchName}</span>{" "}
                already exists in this project.
              </p>
            )}
          </>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="worktree-name" className="block text-sm font-medium">
            Worktree folder
          </label>
          {prMode ? (
            <SegmentedControl
              aria-label="Worktree folder name source"
              value={useBranchAsFolder ? prFolderFrom : "custom"}
              onChange={onPrFolder}
              options={PR_FOLDER_OPTIONS}
              disabled={busy}
              // The row is baseline-aligned for the label and the old
              // checkbox, but a bordered track wants its own centering.
              className="self-center"
              optionClassName="px-2 py-0.5 text-2xs"
            />
          ) : (
            <label
              className={cn(
                "-mx-1 flex cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground select-none",
                !busy && "hover:bg-muted dark:hover:bg-muted/50",
              )}
            >
              <Checkbox
                checked={useBranchAsFolder}
                onCheckedChange={onUseSourceName}
                disabled={busy}
              />
              Use {mode === "checkout" ? "source" : "branch"} name
            </label>
          )}
        </div>
        <Input
          id="worktree-name"
          type="text"
          value={useBranchAsFolder ? folderName : worktreeName}
          onChange={(e) =>
            onWorktreeName(sanitizeWorktreeNameInput(e.target.value))
          }
          placeholder={folderPlaceholder}
          disabled={busy || useBranchAsFolder}
          className={TEXT_INPUT_CLASS}
        />
        {folderTaken && (
          <p className="text-xs text-destructive">
            A worktree folder named{" "}
            <span className="font-mono">{folderName}</span> already exists in
            this project.
          </p>
        )}
        {folderUnusable && (
          <p className="text-xs text-destructive">
            <span className="font-mono">{folderSourceRaw}</span> can't be used
            as a folder name (root, primary, and dot names are reserved). Pick a
            different folder name.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {destLead}
          {deviceLabel ? ` on ${deviceLabel}` : ""} into{" "}
          <span className="font-mono text-foreground/80 select-text">
            {destPath}
          </span>
          {destTrail}
          {!folderTaken && villager}
        </p>
      </div>

      <ToggleRowView
        checked={cloneFiles}
        onCheckedChange={onCloneFiles}
        label="Clone files from an existing checkout"
        description="Copies tracked files in from the primary checkout, or the one on the source branch, as clones that share disk space with the originals. Much faster on large repos."
        disabled={busy}
      />

      {errorMessage && (
        <ErrorBanner
          message={errorMessage}
          title="Couldn't create the worktree"
        />
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || busy} size="sm">
          {busy
            ? "Creating…"
            : deviceLabel
              ? `Create on ${deviceLabel}`
              : "Create worktree"}
        </Button>
      </div>
    </form>
  );
}
