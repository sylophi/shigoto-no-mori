import type { ReactNode } from "react";
import { EyeOff, Files, RotateCw } from "lucide-react";
import { PAGE_HEADER_PADDING } from "../shared/PageHeaderView.tsx";
import { BackButton } from "../../primitives/back-button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { Sheet, SheetContent, SheetTitle } from "../../primitives/sheet.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

// A worktree's files, browsed read-only (WorktreeFiles.tsx binds it):
// the folder tree taken over into the app sidebar, the header, the
// picked file filling the page, and on a phone the tree's sheet.
export function FilesPageView({
  takeover,
  header,
  body,
  sheet,
}: {
  takeover: ReactNode;
  header: ReactNode;
  body: ReactNode;
  sheet: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {takeover}
      {header}
      {body}
      {sheet}
    </div>
  );
}

// The page's header: its title and the worktree, and the tree's
// controls once there are files to show.
export function FilesHeaderView({
  worktreeName,
  back,
  controls,
}: {
  worktreeName: string;
  // A phone's way back. A wide viewport's is the sidebar's first row.
  back: { label: string; onClick: () => void } | null;
  // Absent on a peer that shows no files.
  controls: {
    // A phone's way to the tree, once a file has the page.
    onBrowse: (() => void) | null;
    // The hide-ignored switch, when the header holds it (a phone).
    hideIgnored: ReactNode;
    onRefresh: () => void;
  } | null;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 border-b border-border",
        PAGE_HEADER_PADDING,
      )}
    >
      {back && <BackButton onClick={back.onClick} label={back.label} />}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="truncate text-xl font-medium tracking-tight phone:text-lg">
            Files
          </h1>
          <SimpleTooltip whenTruncated tip={worktreeName}>
            <p className="truncate font-mono text-xs text-muted-foreground select-text">
              {worktreeName}
            </p>
          </SimpleTooltip>
        </div>
        {controls && (
          <div className="flex shrink-0 items-center gap-2 self-center">
            {controls.onBrowse && (
              <ChipButton
                onClick={controls.onBrowse}
                aria-label="Browse files"
                className="py-1.5"
              >
                <Files aria-hidden className="size-3.5" />
              </ChipButton>
            )}
            {controls.hideIgnored}
            <ChipButton
              onClick={controls.onRefresh}
              aria-label="Refresh files"
              className="py-1.5"
            >
              <RotateCw aria-hidden className="size-3.5" />
            </ChipButton>
          </div>
        )}
      </div>
    </header>
  );
}

// Whether the tree leaves ignored files out. Beside the tree: the
// sidebar's back row, or the header on a phone.
export function HideIgnoredToggleView({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <SimpleTooltip tip="Hide ignored files">
      <IconButton
        onClick={onToggle}
        aria-pressed={hidden}
        aria-label="Hide ignored files"
      >
        <EyeOff aria-hidden className="size-4" />
      </IconButton>
    </SimpleTooltip>
  );
}

// What the page holds in place of a file: a peer's note, or the ask to
// pick one.
export function FilesNoteView({ peerNote }: { peerNote: string | null }) {
  return peerNote !== null ? (
    <CenteredMessage className="px-6 text-center">{peerNote}</CenteredMessage>
  ) : (
    <CenteredMessage className="min-h-0 flex-1 bg-background px-6">
      Pick a file to view it.
    </CenteredMessage>
  );
}

// The tree as a phone's bottom sheet, once a file has the page.
export function FilesTreeSheetView({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="gap-0 p-0">
        <SheetTitle className="sr-only">Files</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
