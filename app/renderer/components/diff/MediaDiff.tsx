import type { FileDiffMetadata } from "@pierre/diffs";
import { Loader2 } from "lucide-react";
import { MediaFile } from "@/components/files/MediaFile";
import { CenteredMessage } from "@/components/ui/centered-message";
import { useSeen } from "@/hooks/ui/useSeen";
import { useGitBlob } from "@/hooks/worktrees/useWorktreeFile";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";
import { mediaTypeOf } from "@shared/mediaTypes";

// An image, video or audio file git only says differs: no hunks, so
// pierre draws its header and nothing under it. A pure rename or a mode
// change names no blobs (no `index` line), and its contents didn't
// change, so the header says it all.
export function isMediaBinary(fileDiff: FileDiffMetadata): boolean {
  return (
    fileDiff.hunks.length === 0 &&
    fileDiff.newObjectId !== undefined &&
    mediaTypeOf(fileDiff.name) !== undefined
  );
}

// The file's two sides, drawn under its header: the old one on a rose
// wash, the new one on a green one, like a diff's lines. An added or
// deleted file has the one side.
export function MediaDiff({
  projectId,
  worktreeId,
  fileDiff,
}: {
  projectId: string;
  worktreeId: string;
  fileDiff: FileDiffMetadata;
}) {
  const { type, prevObjectId, newObjectId, name } = fileDiff;
  const before = type === "new" ? undefined : prevObjectId;
  const after = type === "deleted" ? undefined : newObjectId;
  return (
    <div className="flex gap-2 pt-2 phone:flex-col">
      {before !== undefined && (
        <Side
          projectId={projectId}
          worktreeId={worktreeId}
          oid={before}
          path={fileDiff.prevName ?? name}
          side="old"
        />
      )}
      {after !== undefined && (
        <Side
          projectId={projectId}
          worktreeId={worktreeId}
          oid={after}
          path={name}
          side="new"
        />
      )}
    </div>
  );
}

// Read once scrolled near: a patch that regenerates a hundred
// screenshots would otherwise ship every one of them up front.
function Side({
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
    <div
      ref={ref}
      className={cn(
        "h-72 min-w-0 flex-1 rounded-md",
        side === "old" ? "bg-rose-500/10" : "bg-green-500/10",
      )}
    >
      {data === undefined && !isError ? (
        <CenteredMessage>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        </CenteredMessage>
      ) : data?.kind === "media" ? (
        <MediaFile
          mime={data.mime}
          src={`data:${data.mime};base64,${data.base64}`}
        />
      ) : (
        <CenteredMessage className="px-6 text-center">
          {data?.kind === "tooLarge"
            ? `Too large to show here (${formatBytes(data.size)}).`
            : "Can't show this file here."}
        </CenteredMessage>
      )}
    </div>
  );
}
