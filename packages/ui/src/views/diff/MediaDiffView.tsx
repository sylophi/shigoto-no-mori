import type { ReactNode, Ref } from "react";
import { Loader2 } from "lucide-react";
import type { WorktreeFile } from "@shigomori/contracts/schemas";
import { Button } from "../../primitives/button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { EmptyPanel } from "../../primitives/empty-panel.tsx";
import { formatBytes } from "../../lib/formatBytes.ts";
import { cn } from "../../lib/utils.ts";
import { MediaFileView } from "../files/FileViewerView.tsx";

// An image, video or audio file's sides in a diff (MediaDiff.tsx binds
// each to its blob), drawn under the file's header. With `unnamed` the
// patch names a side's blob only in short (a pull request's diff from
// GitHub, its commits not fetched here), so neither side is read, and
// the file says so once: what to do about it.
export function MediaDiffView({
  unnamed,
  children,
}: {
  unnamed?: {
    readonly onRetry: (() => void) | undefined;
    // The ask is out.
    readonly retrying: boolean;
  };
  children?: ReactNode;
}) {
  if (unnamed) {
    return (
      <div className="pt-2">
        <EmptyPanel>
          <div className="flex flex-col items-center gap-2">
            <span>
              Not shown: this needs the pull request&apos;s commits, which
              couldn&apos;t be read here.
            </span>
            {unnamed.onRetry && (
              <Button
                size="sm"
                variant="secondary"
                disabled={unnamed.retrying}
                onClick={unnamed.onRetry}
              >
                {unnamed.retrying && (
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                )}
                Try again
              </Button>
            )}
          </div>
        </EmptyPanel>
      </div>
    );
  }
  return <div className="flex gap-2 pt-2 phone:flex-col">{children}</div>;
}

// One side: the old one on a rose wash, the new one on a green one,
// like a diff's lines.
export function MediaDiffSideView({
  side,
  file,
  reading,
  sideRef,
}: {
  side: "old" | "new";
  // What the side's blob reads as. Undefined while reading, or when it
  // couldn't be read.
  file: WorktreeFile | undefined;
  reading: boolean;
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
      {reading ? (
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
