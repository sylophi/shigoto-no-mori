import type { ReactNode, Ref } from "react";
import { Loader2 } from "lucide-react";
import type { WorktreeFile } from "@shigomori/contracts/schemas";
import { Button } from "../../primitives/button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { formatBytes } from "../../lib/formatBytes.ts";
import { cn } from "../../lib/utils.ts";
import { MediaFileView } from "../files/FileViewerView.tsx";

// An image, video or audio file's sides in a diff (MediaDiff.tsx binds
// each to its blob), drawn under the file's header.
export function MediaDiffView({ children }: { children: ReactNode }) {
  return <div className="flex gap-2 pt-2 phone:flex-col">{children}</div>;
}

// One side: the old one on a rose wash, the new one on a green one,
// like a diff's lines.
export function MediaDiffSideView({
  side,
  file,
  reading,
  unnamed,
  sideRef,
}: {
  side: "old" | "new";
  // What the side's blob reads as. Undefined while reading, or when it
  // couldn't be read.
  file: WorktreeFile | undefined;
  reading: boolean;
  // Set when the patch names the side's blob only in short (a pull
  // request's diff from GitHub, its commits not fetched here), so it
  // can't be read: what to do about it.
  unnamed?: { readonly onRetry: (() => void) | undefined };
  // Read once scrolled near: a patch that regenerates a hundred
  // screenshots would otherwise ship every one of them up front.
  sideRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={sideRef}
      className={cn(
        "h-72 min-w-0 flex-1 rounded-md",
        side === "old" ? "bg-rose-500/10" : "bg-green-500/10",
      )}
    >
      {unnamed ? (
        <CenteredMessage className="flex-col gap-2 px-6 text-center">
          <span>
            Not shown: the pull request&apos;s commits couldn&apos;t be fetched
            here.
          </span>
          {unnamed.onRetry && (
            <Button size="sm" variant="secondary" onClick={unnamed.onRetry}>
              Try again
            </Button>
          )}
        </CenteredMessage>
      ) : reading ? (
        <CenteredMessage>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        </CenteredMessage>
      ) : file?.kind === "media" ? (
        <MediaFileView
          mime={file.mime}
          src={`data:${file.mime};base64,${file.base64}`}
        />
      ) : (
        <CenteredMessage className="px-6 text-center">
          {file?.kind === "tooLarge"
            ? `Too large to show here (${formatBytes(file.size)}).`
            : "Can't show this file here."}
        </CenteredMessage>
      )}
    </div>
  );
}
