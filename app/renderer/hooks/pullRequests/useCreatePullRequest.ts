import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ATTACHMENT_CHUNK_BYTES,
  type CreatePullRequestPayload,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { toast } from "@/lib/toast";
import {
  dropPullRequestDraft,
  pullRequestDraftKey,
} from "@/store/pullRequestDrafts";
import { invalidatePullRequestsForProject } from "../projects/useProjectPullRequests";

// The create pull request dialog's starting point, read once as it opens:
// it seeds the form, and a later answer must not move what was typed.
export function usePullRequestDraft(worktree: Worktree) {
  const { api, keys } = useHostScope();
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };
  return useQuery({
    queryKey: keys.pullRequestDraft(
      input.projectId,
      input.worktreeId,
      worktree.branch,
    ),
    queryFn: ({ signal }) =>
      api.run(api.githubCli.pullRequestDraft(input), { signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// What the PR would hold against the base picked, kept while the next
// base is read so the summary doesn't blink out. Read again as the
// dialog opens, not on every return to the window: the diff behind it
// costs on a big branch.
export function usePullRequestCompare(worktree: Worktree, base: string) {
  const { api, keys } = useHostScope();
  const { projectId, id: worktreeId } = worktree;
  return useQuery({
    queryKey: keys.pullRequestCompare(projectId, worktreeId, base),
    queryFn: ({ signal }) =>
      api.run(
        api.githubCli.pullRequestCompare({ projectId, worktreeId, base }),
        { signal },
      ),
    enabled: base !== "",
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
  });
}

export function usePullRequestOptions(projectId: string) {
  const { api, keys } = useHostScope();
  return useQuery({
    queryKey: keys.pullRequestOptions(projectId),
    queryFn: ({ signal }) =>
      api.run(api.githubCli.pullRequestOptions({ projectId }), { signal }),
    staleTime: 5 * 60_000,
    meta: { silentError: true },
  });
}

// The uploads under way, by attachment, so a removal can stop one.
const uploads = new Map<string, AbortController>();

// Sends a file to the host a chunk at a time (each one fits a peer's
// request frame), where it waits for the PR to be created. Stopped by
// removeAttachment, it drops what the host has once the chunk in
// flight has landed, which would otherwise make the file again.
export async function stageAttachment(
  api: HostApi,
  file: Blob,
  id: string,
  name: string,
): Promise<void> {
  const upload = new AbortController();
  uploads.set(id, upload);
  try {
    for (
      let offset = 0;
      offset < file.size && !upload.signal.aborted;
      offset += ATTACHMENT_CHUNK_BYTES
    ) {
      const chunk = file.slice(offset, offset + ATTACHMENT_CHUNK_BYTES);
      // One after another: each chunk must land where the last one ended.
      // oxlint-disable-next-line no-await-in-loop -- the host appends in order
      const base64 = await blobToBase64(chunk);
      // oxlint-disable-next-line no-await-in-loop -- the host appends in order
      await api.run(
        api.githubCli.stageAttachment({ id, name, offset, base64 }),
      );
    }
  } finally {
    uploads.delete(id);
    if (upload.signal.aborted) await discard(api, id);
  }
}

// An attachment taken out of the form: its upload stopped if it's
// still going, its staged file dropped either way.
export function removeAttachment(api: HostApi, id: string): void {
  const upload = uploads.get(id);
  if (upload) upload.abort();
  else void discard(api, id);
}

// Nothing waits on it: the host sweeps what's left anyway.
function discard(api: HostApi, id: string): Promise<void> {
  return api.run(api.githubCli.discardAttachment({ id })).catch(() => {});
}

async function blobToBase64(blob: Blob): Promise<string> {
  const url = await readDataUrl(blob);
  return url.slice(url.indexOf(",") + 1);
}

// A file's bytes as a data URL.
export function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Couldn't read the file")),
    );
    reader.readAsDataURL(blob);
  });
}

// The PR lookups are asked again here (the worktree's sync counts come
// with the host's view of it, live). The form goes with it, and an
// attachment that didn't make it is said, here on the hook so both
// happen even once the dialog is closed.
export function useCreatePullRequest() {
  const qc = useQueryClient();
  const { api, keys, deviceId } = useHostScope();
  return useMutation({
    // The branch keys the form it was written in.
    mutationFn: ({
      branch: _,
      ...input
    }: CreatePullRequestPayload & { branch: string }) =>
      api.run(api.githubCli.createPullRequest(input)),
    onSuccess: ({ warning }, { projectId, worktreeId, branch }) => {
      invalidatePullRequestsForProject(qc, keys, projectId);
      dropPullRequestDraft(pullRequestDraftKey(deviceId, worktreeId, branch));
      if (warning) {
        toast.warning("Some attachments didn't upload", {
          description: warning,
        });
      }
    },
    meta: { silentError: true },
  });
}
