import type { FileDiffMetadata } from "@pierre/diffs";
import { useSeen } from "@/hooks/ui/useSeen";
import { isFullObjectId } from "@shigomori/contracts/schemas";
import { useGitBlob } from "@/hooks/worktrees/useWorktreeFile";
import {
  MediaDiffSideView,
  MediaDiffView,
} from "@shigomori/ui/views/diff/MediaDiffView.tsx";

// An image, video or audio file's sides in a diff (MediaDiffView), each
// read by the blob id its patch names. An added or deleted file has the
// one side. A patch that names a side only in short says so, with
// `retry` (a pull request's diff asked for again, which fetches its
// commits again).
export function MediaDiff({
  projectId,
  worktreeId,
  fileDiff,
  retry,
}: {
  projectId: string;
  worktreeId: string;
  fileDiff: FileDiffMetadata;
  retry?: { readonly retry: () => void; readonly retrying: boolean };
}) {
  const { type, prevObjectId, newObjectId, name } = fileDiff;
  const before = type === "new" ? undefined : prevObjectId;
  const after = type === "deleted" ? undefined : newObjectId;
  // GitHub's patch shortens both of a changed file's ids alike, so the
  // file says it once rather than once a side.
  const unnamed = [before, after].some(
    (oid) => oid !== undefined && !isFullObjectId(oid),
  );
  if (unnamed) {
    return (
      <MediaDiffView
        unnamed={{ onRetry: retry?.retry, retrying: retry?.retrying ?? false }}
      />
    );
  }
  return (
    <MediaDiffView>
      {before !== undefined && (
        <MediaDiffSide
          projectId={projectId}
          worktreeId={worktreeId}
          oid={before}
          path={fileDiff.prevName ?? name}
          side="old"
        />
      )}
      {after !== undefined && (
        <MediaDiffSide
          projectId={projectId}
          worktreeId={worktreeId}
          oid={after}
          path={name}
          side="new"
        />
      )}
    </MediaDiffView>
  );
}

// One side, read once scrolled near.
function MediaDiffSide({
  projectId,
  worktreeId,
  oid,
  path,
  side,
}: {
  projectId: string;
  worktreeId: string;
  oid: string;
  path: string;
  side: "old" | "new";
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const { data, isError } = useGitBlob(projectId, worktreeId, oid, path, seen);
  return (
    <MediaDiffSideView
      side={side}
      file={data}
      reading={data === undefined && !isError}
      sideRef={ref}
    />
  );
}
