import type { ReactNode, Ref } from "react";
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  type FileDiffMetadata,
  type VirtualFileMetrics,
  type Virtualizer,
} from "@pierre/diffs";
import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import { ChevronDown, Files, Loader2, WrapText } from "lucide-react";
import { PAGE_HEADER_PADDING } from "@/components/shared/PageHeaderView";
import { BackButton } from "@shigomori/ui/primitives/back-button.tsx";
import { CenteredMessage } from "@shigomori/ui/primitives/centered-message.tsx";
import { ChipButton } from "@shigomori/ui/primitives/chip-button.tsx";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { SegmentedControl } from "@shigomori/ui/primitives/segmented-control.tsx";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@shigomori/ui/primitives/sheet.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import {
  CODE_GAP_BLOCK,
  CODE_LINE_HEIGHT,
  CODE_STYLE,
  CODE_THEME,
} from "./codeTheme";
import { HunkBarView, hunkAnnotations, type HunkControls } from "./HunkBarView";

export type DiffStyle = "unified" | "split";

const DIFF_STYLE_OPTIONS = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const;

const DIFF_THEME = {
  ...CODE_THEME,
  // 'simple' is the shortest built-in separator (vs 'line-info' default
  // which renders rounded corners and an expansion-control row).
  hunkSeparators: "simple" as const,
};

// The row sizes CODE_STYLE and DIFF_THEME lay out, for the virtualizer
// to place what it hasn't drawn. It never measures a row, so these have
// to be exact: a wrong one shows as a gap or an overlap at the edge of
// the drawn window. Whole pixels because a fractional line height is
// rounded by layout, and the error adds up over a long file.
const DIFF_METRICS: VirtualFileMetrics = {
  ...DEFAULT_VIRTUAL_FILE_METRICS,
  lineHeight: CODE_LINE_HEIGHT,
  // What pierre's header comes to at CODE_STYLE's sizes. Measured, since
  // nothing in CODE_STYLE sets it directly. It holds in both designs and
  // with or without the fold button: the header keeps its own font.
  diffHeaderHeight: 30,
  // The padding under a file's last row.
  spacing: CODE_GAP_BLOCK,
};

// A diff page (DiffPage.tsx binds it to a patch): the file list taken
// over into the sidebar, the header, the patch, and on a phone the file
// list's sheet.
export function DiffPageView({
  takeover,
  header,
  pane,
  sheet,
}: {
  takeover: ReactNode;
  header: ReactNode;
  pane: ReactNode;
  sheet: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {takeover}
      {header}
      {pane}
      {sheet}
    </div>
  );
}

// The page's header: the title and what it is about, and the view's
// controls beside them.
export function DiffHeaderView({
  title,
  subtitle,
  back,
  steps,
  files,
  wrapLines,
  onToggleWrap,
  diffStyle,
  onDiffStyle,
  details,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  // A phone's way back. A wide viewport's is the sidebar's first row.
  back: { label: string; onClick: () => void } | null;
  steps: ReactNode;
  // The phone's chip that opens the file list's sheet.
  files: { label: string; count: number; onOpen: () => void } | null;
  wrapLines: boolean;
  onToggleWrap: () => void;
  diffStyle: DiffStyle;
  onDiffStyle: (style: DiffStyle) => void;
  details: ReactNode;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 border-b border-border",
        PAGE_HEADER_PADDING,
      )}
    >
      {back && <BackButton onClick={back.onClick} label={back.label} />}
      {/* A phone gives the title its own row and the controls the
          next, rather than a sliver of the width beside them. */}
      <div className="flex items-start justify-between gap-6 phone:flex-wrap phone:gap-3">
        <div className="min-w-0 flex-1 space-y-1 phone:basis-full">
          {/* A phone's header row is shared with the chips, so the
              title wraps there instead of losing its tail. */}
          <SimpleTooltip whenTruncated tip={title}>
            <h1 className="truncate text-xl font-medium tracking-tight select-text phone:text-lg phone:whitespace-normal">
              {title}
            </h1>
          </SimpleTooltip>
          <SimpleTooltip whenTruncated tip={subtitle}>
            <p className="truncate text-xs text-muted-foreground select-text">
              {subtitle}
            </p>
          </SimpleTooltip>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-center">
          {steps}
          {files && (
            <ChipButton
              onClick={files.onOpen}
              aria-label={`${files.label} (${files.count})`}
              className="py-1.5"
            >
              <Files aria-hidden className="size-3.5" />
              <span className="tabular">{files.count}</span>
            </ChipButton>
          )}
          <SimpleTooltip tip="Wrap long lines">
            <IconButton
              onClick={onToggleWrap}
              aria-pressed={wrapLines}
              aria-label="Wrap long lines"
            >
              <WrapText aria-hidden className="size-4" />
            </IconButton>
          </SimpleTooltip>
          <SegmentedControl
            aria-label="Diff layout"
            className="self-center"
            optionClassName="px-2 py-1 text-xs"
            value={diffStyle}
            onChange={onDiffStyle}
            options={DIFF_STYLE_OPTIONS}
          />
        </div>
      </div>
      {details}
    </header>
  );
}

// The scrolling pane under the header: the patch's files, or what
// stands in for them.
export function DiffPaneView({
  scrollRef,
  listRef,
  state,
  message,
  virtualizer,
  children,
}: {
  scrollRef?: Ref<HTMLDivElement>;
  listRef?: Ref<HTMLDivElement>;
  // "empty" shows the message in place of the files.
  state: "loading" | "error" | "empty" | "files";
  message: ReactNode;
  virtualizer: Virtualizer | null;
  // The files' rows (DiffFileRowView).
  children: ReactNode;
}) {
  return (
    <div
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto bg-background"
    >
      {state === "loading" ? (
        <CenteredMessage>
          <Loader2 aria-hidden className="mr-2 size-3.5 animate-spin" />
          Computing diff…
        </CenteredMessage>
      ) : state === "error" ? (
        <CenteredMessage className="px-6">
          Couldn't compute diff.
        </CenteredMessage>
      ) : state === "empty" ? (
        <CenteredMessage className="px-6 text-center">
          {message}
        </CenteredMessage>
      ) : (
        <div
          ref={listRef}
          data-slot="diff-view"
          className="flex flex-col gap-2 p-2 select-text"
          style={CODE_STYLE}
        >
          {virtualizer ? (
            <VirtualizerContext value={virtualizer}>
              {children}
            </VirtualizerContext>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// The file list as a phone's bottom sheet: a patch is still easier to
// read with its map to hand.
export function DiffFilesSheetView({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="gap-0 p-0">
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <div className="flex h-[70dvh] w-full flex-col">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

// One file of the patch. Its own component so folding a file re-renders
// that file and not the other 130: pierre's FileDiff re-runs a full DOM
// render on every pass, so untouched rows have to keep their cached
// element to stay free. That only holds while every prop here is stable
// per file, which is why `onToggle` is the caller's own setter rather
// than a per-row closure.
//
// The wrapper is what the index scrolls to and what the scroll spy
// observes. `collapsed` is pierre's own option: it drops the file's
// rendered rows and keeps the header, so folding a file also stops
// paying for it.
export function DiffFileRowView({
  fileDiff,
  fileId,
  collapsed,
  diffStyle,
  wrapLines,
  themeType,
  onToggle,
  hunks,
  busy,
}: {
  fileDiff: FileDiffMetadata;
  fileId: string;
  collapsed: boolean;
  diffStyle: DiffStyle;
  // Wrapped rows run past CODE_LINE_HEIGHT, so DIFF_METRICS no longer
  // places them exactly. Pierre measures each wrapped row as it draws
  // and corrects the file's height, so a long file's scrollbar settles
  // as you read rather than up front.
  wrapLines: boolean;
  themeType: "light" | "dark";
  // Absent when the pane shows one picked file, where there is nothing
  // to fold away. The header prefix goes with it.
  onToggle: ((key: string, collapsed: boolean) => void) | undefined;
  // The changes page's hunk ticks for this file, when it has them.
  hunks: HunkControls | undefined;
  busy: boolean;
}) {
  return (
    <div data-diff-file={fileId}>
      {/* `PatchDiff` requires a single-file patch. For multi-file output
          we parse with `parsePatchFiles` and spawn one `<FileDiff>` per
          file per the library's recommended pattern. */}
      <FileDiff
        fileDiff={fileDiff}
        options={{
          ...DIFF_THEME,
          diffStyle,
          overflow: wrapLines ? "wrap" : "scroll",
          themeType,
          collapsed,
        }}
        metrics={DIFF_METRICS}
        lineAnnotations={hunks && hunkAnnotations(fileDiff, hunks.states)}
        renderAnnotation={
          hunks
            ? (annotation) => (
                <HunkBarView
                  group={annotation.metadata}
                  controls={hunks}
                  busy={busy}
                />
              )
            : undefined
        }
        renderHeaderPrefix={
          onToggle
            ? () => (
                <button
                  type="button"
                  onClick={() => onToggle(fileId, !collapsed)}
                  aria-expanded={!collapsed}
                  aria-label={
                    collapsed
                      ? `Expand ${fileDiff.name}`
                      : `Collapse ${fileDiff.name}`
                  }
                  data-icon-button
                  className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-3.5 transition-transform",
                      collapsed && "-rotate-90",
                    )}
                  />
                </button>
              )
            : undefined
        }
      />
    </div>
  );
}
