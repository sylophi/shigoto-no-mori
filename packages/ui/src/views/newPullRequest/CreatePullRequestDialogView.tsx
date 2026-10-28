// The create pull request dialog's content (CreatePullRequestDialog puts
// it in a ModalShell).
import type { ReactNode } from "react";
import { ArrowLeft, ChevronDown, GitPullRequest, Loader2 } from "lucide-react";
import type {
  PullRequestCompare,
  PullRequestOptions,
} from "@shigomori/contracts/schemas";
import { Button } from "../../primitives/button.tsx";
import { DiffStats } from "../../primitives/diff-stats.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../primitives/dropdown-menu.tsx";
import { ErrorBanner } from "../../primitives/error-banner.tsx";
import { Input } from "../../primitives/input.tsx";
import { TONE_PILL } from "../../primitives/status-dot.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { pluralize } from "@shigomori/contracts/words";
import type { Attachment } from "../../lib/pullRequestAttachments.ts";
import {
  FlowBodyView,
  FlowFooterView,
  FlowHeaderView,
} from "../worktreeDetail/flow/FlowChromeView.tsx";
import { DescriptionEditorView } from "./DescriptionEditorView.tsx";
import { MultiPickerView } from "./MultiPickerView.tsx";

// What the form holds, as the dialog has it now.
interface PullRequestForm {
  base: string;
  title: string;
  body: string;
  reviewers: readonly string[];
  assignees: readonly string[];
  labels: readonly string[];
  attachments: readonly Attachment[];
}

// A pull request from the worktree's branch, written the way GitHub's
// compare page writes one: the branch it merges into, what it brings, a
// title and a markdown description with images and videos, and who
// reviews it. Created ready or as a draft.
export function CreatePullRequestDialogView({
  branch,
  basePicker,
  form,
  compare,
  seedError,
  compareError,
  createError,
  options,
  optionsPending,
  unpushed,
  blocked,
  ready,
  busy,
  descriptionDisabled,
  onTitle,
  onBody,
  onReviewers,
  onAssignees,
  onLabels,
  onAttach,
  onRemoveAttachment,
  onCreate,
  onCancel,
  onClose,
}: {
  // The worktree's branch, the PR's head.
  branch: string;
  // The pick of the base (BranchCombobox).
  basePicker: ReactNode;
  form: PullRequestForm;
  // What the PR would hold against the base, once read.
  compare: PullRequestCompare | undefined;
  seedError: string | undefined;
  compareError: string | undefined;
  createError: string | undefined;
  options: PullRequestOptions | undefined;
  optionsPending: boolean;
  // The commits the create pushes first.
  unpushed: number;
  // Why it can't be created yet, said on the button.
  blocked: string | null;
  ready: boolean;
  busy: boolean;
  descriptionDisabled: boolean;
  onTitle: (title: string) => void;
  onBody: (body: string) => void;
  onReviewers: (next: string[]) => void;
  onAssignees: (next: string[]) => void;
  onLabels: (next: string[]) => void;
  onAttach: (
    incoming: { files: File[]; links: { url: string; alt: string }[] },
    selection: { start: number; end: number },
  ) => void;
  onRemoveAttachment: (attachment: Attachment) => void;
  onCreate: (draft: boolean) => void;
  onCancel: () => void;
  // The header's close, which waits while a create runs.
  onClose: () => void;
}) {
  const people = (options?.people ?? []).map((person) => ({
    value: person.login,
    detail: person.name,
  }));
  return (
    <>
      <FlowHeaderView
        tint={TONE_PILL.emerald}
        icon={GitPullRequest}
        title="Create pull request"
        onClose={onClose}
      >
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {/* Base, arrow and branch wrap as one, the branch truncating. */}
          <span className="flex min-w-0 items-center gap-2">
            <label htmlFor="pull-request-base" className="sr-only">
              Base branch
            </label>
            {basePicker}
            <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
            <SimpleTooltip whenTruncated tip={branch}>
              <span className="min-w-0 truncate font-mono text-foreground">
                {branch}
              </span>
            </SimpleTooltip>
          </span>
          {compare && (
            <span className="ml-auto flex items-center gap-3">
              <span>
                {pluralize(compare.commits, "commit")},{" "}
                {pluralize(compare.files, "file")}
              </span>
              <DiffStats
                additions={compare.additions}
                deletions={compare.deletions}
              />
            </span>
          )}
        </div>
      </FlowHeaderView>

      <FlowBodyView>
        <div className="flex flex-col gap-5">
          {seedError !== undefined && (
            <ErrorBanner title="Couldn't read the branch" message={seedError} />
          )}
          {compareError !== undefined && (
            <ErrorBanner
              title={`Couldn't compare with ${form.base}`}
              message={compareError}
            />
          )}
          <Input
            aria-label="Title"
            placeholder="Title"
            value={form.title}
            maxLength={256}
            className="w-full px-3 py-2 text-sm"
            onChange={(e) => onTitle(e.target.value)}
            disabled={busy}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog only exists because the user just asked to write the PR, so the caret starts in its title
            autoFocus
            // The draft's title lands after the dialog opens, focused.
            selectOutsideChanges
          />
          <DescriptionEditorView
            value={form.body}
            onChange={onBody}
            attach={{
              attachments: form.attachments,
              onAttach,
              onRemove: onRemoveAttachment,
            }}
            disabled={descriptionDisabled}
          />
          <div className="grid grid-cols-3 gap-6 phone:grid-cols-1 phone:gap-4">
            <MultiPickerView
              label="Reviewers"
              options={people.filter((p) => p.value !== options?.viewer)}
              value={form.reviewers}
              onChange={onReviewers}
              loading={optionsPending}
              empty="No one to ask"
              disabled={busy}
            />
            <MultiPickerView
              label="Assignees"
              options={people}
              value={form.assignees}
              onChange={onAssignees}
              loading={optionsPending}
              empty="No one to assign"
              disabled={busy}
            />
            <MultiPickerView
              label="Labels"
              options={(options?.labels ?? []).map((label) => ({
                value: label.name,
                detail: label.description,
                color: label.color,
              }))}
              value={form.labels}
              onChange={onLabels}
              loading={optionsPending}
              empty="The repo has no labels"
              disabled={busy}
            />
          </div>
          {createError !== undefined && (
            <ErrorBanner
              title="Couldn't create the pull request"
              message={createError}
            />
          )}
        </div>
      </FlowBodyView>

      <FlowFooterView
        note={unpushed > 0 && `Pushes ${pluralize(unpushed, "commit")} first`}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <div className="inline-flex items-stretch">
          <SimpleTooltip tip={busy ? undefined : (blocked ?? undefined)}>
            <Button
              type="button"
              size="sm"
              disabled={!ready}
              onClick={() => onCreate(false)}
              className="rounded-r-none"
            >
              {busy && <Loader2 aria-hidden className="animate-spin" />}
              {busy ? "Creating…" : "Create pull request"}
            </Button>
          </SimpleTooltip>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  disabled={!ready}
                  aria-label="More ways to create"
                  className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                >
                  <ChevronDown aria-hidden className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem onClick={() => onCreate(true)}>
                Create draft pull request
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </FlowFooterView>
    </>
  );
}
