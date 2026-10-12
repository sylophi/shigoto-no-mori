import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { CreatePullRequestDialogView } from "@shigomori/ui/views/newPullRequest/CreatePullRequestDialogView.tsx";
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
} from "@shigomori/ui/lib/pullRequestAttachments.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";
import type { Worktree } from "@shigomori/contracts/schemas";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
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
import { toast } from "@/lib/toast";
import {
  patchPullRequestDraft,
  pullRequestDraftForm as formOf,
  pullRequestDraftKey,
  usePullRequestDraftForm,
} from "@/store/pullRequestDrafts";

// The create pull request dialog (CreatePullRequestDialogView): where it
// starts (a stacked branch on the one below it, the branch's commits or
// the repo's template), the uploads, and the create, which pushes the
// branch first. Dismissed, the form stays as it was left
// (store/pullRequestDrafts), uploads and all, for the next time it's
// opened. Only making the PR clears it.
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
      api.run(api.githubCli.stageAttachmentFromUrl({ id, stem, url })).then(
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

  // Held open while it runs: closed, its failure would go unsaid.
  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <ModalShell
      label="Create pull request"
      onClose={dismiss}
      popoverClassName="max-w-3xl"
    >
      <CreatePullRequestDialogView
        branch={worktree.branch}
        basePicker={
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
        }
        form={{ ...form, base, title, body }}
        compare={compare.data}
        seedError={seedError?.message}
        compareError={compare.error?.message}
        createError={create.error?.message}
        options={options}
        optionsPending={optionsPending}
        unpushed={unpushed}
        blocked={blocked}
        ready={ready}
        busy={busy}
        descriptionDisabled={busy || !seeded}
        onTitle={(next) => patch(() => ({ title: next }))}
        onBody={(next) => patch(() => ({ body: next }))}
        onReviewers={(next) => patch(() => ({ reviewers: next }))}
        onAssignees={(next) => patch(() => ({ assignees: next }))}
        onLabels={(next) => patch(() => ({ labels: next }))}
        onAttach={attach}
        onRemoveAttachment={(attachment) => {
          patch((current) => ({
            body: withoutReference(current.body ?? body, attachment.name),
            attachments: current.attachments.filter(
              (a) => a.id !== attachment.id,
            ),
          }));
          removeAttachment(api, attachment.id);
        }}
        onCreate={submit}
        onCancel={onClose}
        onClose={dismiss}
      />
    </ModalShell>
  );
}
