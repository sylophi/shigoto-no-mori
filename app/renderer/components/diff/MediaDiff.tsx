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
  retry?: () => void;
}) {
  const { type, prevObjectId, newObjectId, name } = fileDiff;
  const before = type === "new" ? undefined : prevObjectId;
  const after = type === "deleted" ? undefined : newObjectId;
  return (
    <MediaDiffView>
      {before !== undefined && (
        <MediaDiffSide
          projectId={projectId}
          worktreeId={worktreeId}
          oid={before}
          path={fileDiff.prevName ?? name}
          side="old"
          retry={retry}
        />
      )}
      {after !== undefined && (
        <MediaDiffSide
          projectId={projectId}
          worktreeId={worktreeId}
          oid={after}
          path={name}
          side="new"
          retry={retry}
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
  retry,
}: {
  projectId: string;
  worktreeId: string;
  oid: string;
  path: string;
  side: "old" | "new";
  retry: (() => void) | undefined;
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const named = isFullObjectId(oid);
  const { data, isError } = useGitBlob(
    projectId,
    worktreeId,
    oid,
    path,
    seen && named,
  );
  return (
    <MediaDiffSideView
      side={side}
      file={data}
      reading={data === undefined && !isError}
      unnamed={named ? undefined : { onRetry: retry }}
      sideRef={ref}
    />
  );
}
