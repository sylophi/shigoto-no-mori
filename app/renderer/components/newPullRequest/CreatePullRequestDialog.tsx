import { ArrowLeft, ChevronDown, GitPullRequest, Loader2 } from "lucide-react";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { Button } from "@/components/ui/button";
import { DiffStats } from "@/components/ui/diff-stats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  FlowBody,
  FlowFooter,
  FlowHeader,
} from "@/components/worktreeDetail/flow/FlowChrome";
import {
  readDataUrl,
  removeAttachment,
  stageAttachment,
  useCreatePullRequest,
  usePullRequestCompare,
  usePullRequestDraft,
  usePullRequestOptions,
} from "@/hooks/pullRequests/useCreatePullRequest";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { pluralize } from "@/lib/pluralize";
import { toast } from "@/lib/toast";
import {
  patchPullRequestDraft,
  pullRequestDraftForm as formOf,
  pullRequestDraftKey,
  usePullRequestDraftForm,
} from "@/store/pullRequestDrafts";
import { errorMessageOf } from "@shared/errors";
import type { Worktree } from "@shared/schemas";
import {
  attachmentMarkdown,
  attachmentName,
  attachmentRefusal,
  attachmentStems,
  dataUrlFile,
  insertBlock,
  isVideo,
  linkStem,
  newAttachmentId,
  stemOf,
  refersTo,
  uploadingMarkdown,
  withFetchedName,
  withoutReference,
  type Attachment,
} from "@/lib/pullRequestAttachments";
import { DescriptionEditor } from "./DescriptionEditor";
import { MultiPicker } from "./MultiPicker";

// A pull request from the worktree's branch, written the way GitHub's
// compare page writes one: the branch it merges into (a stacked branch
// starts on the one below it), what it brings, a title and a markdown
// description with images and videos, and who reviews it. Created
// ready or as a draft, pushing the branch first. Dismissed, the form
// stays as it was left (store/pullRequestDrafts), uploads and all, for
// the next time it's opened. Only making the PR clears it.
export function CreatePullRequestDialog({
  worktree,
  onClose,
}: {
  worktree: Worktree;
  onClose: () => void;
}) {
  const { api, deviceId } = useHostScope();
  const key = pullRequestDraftKey(deviceId, worktree.id, worktree.branch);
  const form = usePullRequestDraftForm(key);
  const patch = (next: Parameters<typeof patchPullRequestDraft>[1]) =>
    patchPullRequestDraft(key, next);

  const { data: seed, error: seedError } = usePullRequestDraft(worktree);
  const { data: options, isPending: optionsPending } = usePullRequestOptions(
    worktree.projectId,
  );
  const primary = worktree.primaryBranch ?? "";
  // Waits for the seed, so a stacked branch doesn't first compare
  // against the primary branch.
  const base =
    form.base ??
    (seed ? (seed.suggestedBase ?? primary) : seedError ? primary : "");
  const compare = usePullRequestCompare(worktree, base);
  const create = useCreatePullRequest();

  const title = form.title ?? worktree.title ?? seed?.fill.title ?? "";
  const body =
    form.body ??
    worktree.description ??
    seed?.template ??
    seed?.fill.body ??
    "";
  const referenced = form.attachments.filter((a) => refersTo(body, a.name));
  const uploading = referenced.some((a) => a.status === "staging");
  const failed = referenced.some((a) => a.status === "failed");
  const commits = compare.data?.commits ?? 0;
  const unpushed = worktree.hasUpstream
    ? worktree.ahead
    : worktree.unpushedCount;
  const busy = create.isPending;
  // The description waits for its seed (the template, or the commits'
  // text): one written before it lands would keep the seed out.
  const seeded = seed !== undefined || seedError !== null;
  const blocked =
    title.trim() === ""
      ? "Give it a title"
      : compare.data && commits === 0
        ? `Nothing to merge into ${base}`
        : uploading
          ? "Waiting for the attachments to upload"
          : failed
            ? "Remove the attachments that didn't upload"
            : null;
  // The compare shown can still be the last base's while the picked
  // one is read, and what the button says has to be about this one.
  const compared = compare.isSuccess && !compare.isPlaceholderData;
  const ready = blocked === null && compared && !busy;

  // Files go up from here, a chunk at a time. A link is fetched by the
  // host, its place held by a placeholder until its type names it. An
  // image inside pasted HTML (a data: URL) is a file already.
  const attach = (
    incoming: { files: File[]; links: { url: string; alt: string }[] },
    at: { start: number; end: number },
  ) => {
    const embedded = incoming.links.filter(({ url }) => /^data:/i.test(url));
    const files = [
      ...incoming.files,
      ...embedded.flatMap(({ url }) => dataUrlFile(url) ?? []),
    ];
    if (files.length < incoming.files.length + embedded.length) {
      toast.error("Couldn't attach", {
        description: "An image in what was pasted couldn't be read",
      });
    }
    const links = incoming.links.filter(({ url }) => /^https?:/i.test(url));
    const stems = attachmentStems(form.attachments);
    const added: { attachment: Attachment; markdown: string; file: File }[] =
      [];
    for (const file of files) {
      const refusal = attachmentRefusal(file);
      if (refusal) {
        toast.error("Couldn't attach", { description: refusal });
        continue;
      }
      const name = attachmentName(
        { name: file.name || "image", type: file.type },
        stems,
      );
      stems.add(stemOf(name));
      added.push({
        file,
        markdown: attachmentMarkdown(name, stemOf(file.name || "image")),
        attachment: {
          id: newAttachmentId(),
          name,
          previewUrl: null,
          status: "staging",
        },
      });
    }
    const fetched = links.map(({ url, alt }) => {
      const id = newAttachmentId();
      const stem = linkStem(url, stems);
      stems.add(stem);
      const attachment: Attachment = {
        id,
        name: id,
        label: stem,
        previewUrl: url,
        status: "staging",
      };
      return { attachment, url, stem, alt: alt || stem };
    });
    if (added.length + fetched.length === 0) return;
    const markdown = [
      ...added.map((entry) => entry.markdown),
      ...fetched.map(({ attachment, stem }) =>
        uploadingMarkdown(attachment.id, stem),
      ),
    ].join("\n\n");
    // Into the text as it is now (the seed while it's untouched), so a
    // second paste before a render doesn't write over the first.
    patch((current) => ({
      body: insertBlock(current.body ?? body, at.start, at.end, markdown),
      attachments: [
        ...current.attachments,
        ...added.map((entry) => entry.attachment),
        ...fetched.map((entry) => entry.attachment),
      ],
    }));
    const update = (id: string, next: Partial<Attachment>) =>
      patch((current) => ({
        attachments: current.attachments.map((a) =>
          a.id === id ? { ...a, ...next } : a,
        ),
      }));
    const fail = (id: string) => (err: unknown) =>
      update(id, {
        status: "failed",
        error: errorMessageOf(err),
      });
    for (const { attachment, file } of added) {
      if (!isVideo(file.type)) {
        void readDataUrl(file).then((previewUrl) =>
          update(attachment.id, { previewUrl }),
        );
      }
      stageAttachment(api, file, attachment.id, attachment.name).then(
        () => update(attachment.id, { status: "staged" }),
        fail(attachment.id),
      );
    }
    for (const { attachment, url, stem, alt } of fetched) {
      const { id } = attachment;
      api.githubCli.stageAttachmentFromUrl({ id, stem, url }).then(
        ({ name, type }) => {
          // Taken out while it was fetched: what came goes too.
          if (!formOf(key).attachments.some((a) => a.id === id)) {
            removeAttachment(api, id);
            return;
          }
          patch((current) => ({
            body: withFetchedName(current.body ?? "", id, stem, name, alt),
            attachments: current.attachments.map((a) =>
              a.id === id
                ? {
                    ...a,
                    name,
                    label: undefined,
                    previewUrl: isVideo(type) ? null : a.previewUrl,
                    status: "staged",
                  }
                : a,
            ),
          }));
        },
        (err: unknown) => {
          patch((current) => ({
            body: withoutReference(current.body ?? "", id),
          }));
          fail(id)(err);
        },
      );
    }
  };

  const submit = (draft: boolean) => {
    if (!ready) return;
    create.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        branch: worktree.branch,
        base,
        title: title.trim(),
        body,
        draft,
        reviewers: form.reviewers,
        assignees: form.assignees,
        labels: form.labels,
        attachments: referenced.map(({ id, name }) => ({ id, name })),
      },
      { onSuccess: onClose },
    );
  };

  const people = (options?.people ?? []).map((person) => ({
    value: person.login,
    detail: person.name,
  }));
  // Held open while it runs: closed, its failure would go unsaid.
  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <ModalShell onClose={dismiss} popoverClassName="max-w-3xl">
      <FlowHeader
        tint={TONE_PILL.emerald}
        icon={GitPullRequest}
        title="Create pull request"
        onClose={dismiss}
      >
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {/* Base, arrow and branch wrap as one, the branch truncating. */}
          <span className="flex min-w-0 items-center gap-2">
            <label htmlFor="pull-request-base" className="sr-only">
              Base branch
            </label>
            <BranchCombobox
              id="pull-request-base"
              projectId={worktree.projectId}
              value={base}
              onChange={(next) => {
                patch(() => ({ base: next }));
                create.reset();
              }}
              remoteNames
              excludeBranches={[worktree.branch]}
              pinnedBranch={primary || undefined}
              placeholder="Base branch"
              disabled={busy}
              className="w-auto max-w-56 py-1 text-xs"
            />
            <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
            <SimpleTooltip whenTruncated tip={worktree.branch}>
              <span className="min-w-0 truncate font-mono text-foreground">
                {worktree.branch}
              </span>
            </SimpleTooltip>
          </span>
          {compare.data && (
            <span className="ml-auto flex items-center gap-3">
              <span>
                {pluralize(commits, "commit")},{" "}
                {pluralize(compare.data.files, "file")}
              </span>
              <DiffStats
                additions={compare.data.additions}
                deletions={compare.data.deletions}
              />
            </span>
          )}
        </div>
      </FlowHeader>

      <FlowBody>
        <div className="flex flex-col gap-5">
          {seedError && (
            <ErrorBanner
              title="Couldn't read the branch"
              message={seedError.message}
            />
          )}
          {compare.error && (
            <ErrorBanner
              title={`Couldn't compare with ${base}`}
              message={compare.error.message}
            />
          )}
          <Input
            aria-label="Title"
            placeholder="Title"
            value={title}
            maxLength={256}
            className="w-full px-3 py-2 text-sm"
            onChange={(e) => patch(() => ({ title: e.target.value }))}
            disabled={busy}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog only exists because the user just asked to write the PR, so the caret starts in its title
            autoFocus
          />
          <DescriptionEditor
            value={body}
            onChange={(next) => patch(() => ({ body: next }))}
            attachments={form.attachments}
            onAttach={attach}
            onRemove={(attachment) => {
              patch((current) => ({
                body: withoutReference(current.body ?? body, attachment.name),
                attachments: current.attachments.filter(
                  (a) => a.id !== attachment.id,
                ),
              }));
              removeAttachment(api, attachment.id);
            }}
            disabled={busy || !seeded}
          />
          <div className="grid grid-cols-3 gap-6 phone:grid-cols-1 phone:gap-4">
            <MultiPicker
              label="Reviewers"
              options={people.filter((p) => p.value !== options?.viewer)}
              value={form.reviewers}
              onChange={(next) => patch(() => ({ reviewers: next }))}
              loading={optionsPending}
              empty="No one to ask"
              disabled={busy}
            />
            <MultiPicker
              label="Assignees"
              options={people}
              value={form.assignees}
              onChange={(next) => patch(() => ({ assignees: next }))}
              loading={optionsPending}
              empty="No one to assign"
              disabled={busy}
            />
            <MultiPicker
              label="Labels"
              options={(options?.labels ?? []).map((label) => ({
                value: label.name,
                detail: label.description,
                mark: (
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${label.color}` }}
                  />
                ),
              }))}
              value={form.labels}
              onChange={(next) => patch(() => ({ labels: next }))}
              loading={optionsPending}
              empty="The repo has no labels"
              disabled={busy}
            />
          </div>
          {create.error && (
            <ErrorBanner
              title="Couldn't create the pull request"
              message={create.error.message}
            />
          )}
        </div>
      </FlowBody>

      <FlowFooter
        note={unpushed > 0 && `Pushes ${pluralize(unpushed, "commit")} first`}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
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
              onClick={() => submit(false)}
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
              <DropdownMenuItem onClick={() => submit(true)}>
                Create draft pull request
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </FlowFooter>
    </ModalShell>
  );
}
