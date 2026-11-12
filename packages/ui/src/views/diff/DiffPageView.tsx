import type { ReactNode, Ref } from "react";
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type VirtualFileMetrics,
  type Virtualizer,
} from "@pierre/diffs";
import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import { Files, Loader2, WrapText } from "lucide-react";
import { PAGE_HEADER_PADDING } from "../shared/PageHeaderView.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { EmptyPanel } from "../../primitives/empty-panel.tsx";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { CopyButton } from "../../primitives/copy-button.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { BottomSheet } from "../../primitives/sheet.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { fileKey, isBinaryChange } from "../../lib/patchFiles.ts";
import { cn } from "../../lib/utils.ts";
import {
  CODE_GAP_BLOCK,
  CODE_LINE_HEIGHT,
  CODE_STYLE,
  CODE_THEME,
} from "./codeTheme.ts";
import {
  type FindBar,
  FindBarView,
  FindButtonView,
  type FindToggle,
} from "../shared/FindBarView.tsx";
import {
  HunkBarView,
  hunkAnnotations,
  type HunkControls,
} from "./HunkBarView.tsx";
import { SHOWS_LATE } from "../../primitives/skeleton.tsx";

export type DiffStyle = "unified" | "split";

const DIFF_STYLE_OPTIONS = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const;

const DIFF_THEME = {
  ...CODE_THEME,
  // A line-tall bar over each hunk that counts the lines hidden there,
  // and expands them a step at a time once the file's sides can be read.
  // The one under the last hunk isn't drawn: until the sides load it
  // can't count what follows. It keeps its place, which pierre's layout
  // counts.
  hunkSeparators: "line-info-basic" as const,
  expansionLineCount: 20,
  // pierre's header counts deletions first. Additions lead everywhere
  // else (DiffStats), the file list beside it included.
  unsafeCSS: `${CODE_THEME.unsafeCSS} [data-separator="line-info-basic"] { height: ${CODE_LINE_HEIGHT}px; } [data-separator-last] { visibility: hidden; } [data-separator-content] { font-family: var(--font-sans); font-size: var(--text-2xs); } [data-additions-count] { order: -1; }`,
};

// A binary file's header: git counts no lines in it, so pierre's "-0 +0"
// goes.
const BINARY_THEME = {
  ...DIFF_THEME,
  unsafeCSS: `${DIFF_THEME.unsafeCSS} [data-deletions-count], [data-additions-count] { display: none; }`,
};

// The row sizes CODE_STYLE and DIFF_THEME lay out, for the virtualizer
// to place what it hasn't drawn. It never measures a row, so these have
// to be exact: a wrong one shows as a gap or an overlap at the edge of
// the drawn window. Whole pixels because a fractional line height is
// rounded by layout, and the error adds up over a long file.
const DIFF_METRICS: VirtualFileMetrics = {
  ...DEFAULT_VIRTUAL_FILE_METRICS,
  lineHeight: CODE_LINE_HEIGHT,
  hunkSeparatorHeight: CODE_LINE_HEIGHT,
  // What pierre's header comes to at CODE_STYLE's sizes. Measured, since
  // nothing in CODE_STYLE sets it directly. It holds in both designs: the
  // header keeps its own font.
  diffHeaderHeight: 30,
  // The padding under a file's last row.
  spacing: CODE_GAP_BLOCK,
};

// A diff page (DiffPage.tsx binds it to a patch): the file list taken
// over into the sidebar, the header, the find bar while it's open, the
// patch, and on a phone the file list's sheet.
export function DiffPageView({
  takeover,
  header,
  findBar,
  pane,
  sheet,
}: {
  takeover: ReactNode;
  header: ReactNode;
  findBar: FindBar | null;
  pane: ReactNode;
  sheet: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {takeover}
      {header}
      {findBar && <FindBarView {...findBar} />}
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
  subtitleEnd,
  files,
  find,
  wrapLines,
  onToggleWrap,
  diffStyle,
  onDiffStyle,
  details,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  // What ends the subtitle's line past its text, which stays the part
  // that truncates: the branch page's base picker.
  subtitleEnd?: ReactNode;
  // The phone's chip that opens the file list's sheet.
  files: { label: string; count: number; onOpen: () => void } | null;
  find: FindToggle | null;
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
      {/* A phone gives the title its own row and the controls the
          next, rather than a sliver of the width beside them. */}
      <div className="flex items-start justify-between gap-6 phone:flex-wrap phone:gap-3">
        <div className="min-w-0 flex-1 space-y-1 phone:basis-full">
          {/* A phone's header row is shared with the chips, so the
              title wraps there instead of losing its tail. */}
          <SimpleTooltip whenTruncated tip={title}>
            <h1 className="truncate text-lg font-medium tracking-tight select-text phone:whitespace-normal">
              {title}
            </h1>
          </SimpleTooltip>
          <div className="flex items-center gap-1">
            <SimpleTooltip whenTruncated tip={subtitle}>
              <p className="min-w-0 truncate text-xs text-muted-foreground select-text">
                {subtitle}
              </p>
            </SimpleTooltip>
            {subtitleEnd}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-center">
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
          {find && <FindButtonView {...find} />}
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

// The scrolling pane under the header: the file being read, or what
// stands in for it.
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
  // "empty" shows the message in place of the file.
  state: "loading" | "error" | "empty" | "files";
  message: ReactNode;
  virtualizer: Virtualizer | null;
  // The file's row (DiffFileRowView).
  children: ReactNode;
}) {
  return (
    <div
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto bg-background"
    >
      {state === "loading" ? (
        <CenteredMessage className={SHOWS_LATE}>
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
          className="p-2 select-text"
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

// The file list as a phone's bottom sheet, the way to another of the
// patch's files there.
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
    <BottomSheet open={open} onOpenChange={onOpenChange} title={title}>
      <div className="flex h-[70cqh] w-full flex-col">{children}</div>
    </BottomSheet>
  );
}

// The file of the patch being read.
export function DiffFileRowView({
  fileDiff,
  diffStyle,
  wrapLines,
  themeType,
  hunks,
  busy,
  media,
  loadSides,
}: {
  fileDiff: FileDiffMetadata;
  diffStyle: DiffStyle;
  // Wrapped rows run past CODE_LINE_HEIGHT, so DIFF_METRICS no longer
  // places them exactly. Pierre measures each wrapped row as it draws
  // and corrects the file's height, so a long file's scrollbar settles
  // as you read rather than up front.
  wrapLines: boolean;
  themeType: "light" | "dark";
  // The changes page's hunk ticks for this file, when it has them.
  hunks: HunkControls | undefined;
  busy: boolean;
  // An image, video or audio file's sides (MediaDiffView), which its
  // patch has no lines for. Any other binary file says it isn't shown.
  media?: ReactNode;
  // Reads a changed file's two sides, for its hidden lines to expand.
  loadSides?: FileDiffContentsLoader;
}) {
  const binary = isBinaryChange(fileDiff);
  return (
    // The header is pierre's shadow DOM, out of a hover's reach, so the
    // copy button shows while its file is hovered.
    <div data-diff-file={fileKey(fileDiff)} className="group/copy">
      <FileDiff
        fileDiff={fileDiff}
        options={{
          ...(binary ? BINARY_THEME : DIFF_THEME),
          diffStyle,
          overflow: wrapLines ? "wrap" : "scroll",
          themeType,
          loadDiffFiles: loadSides,
        }}
        metrics={DIFF_METRICS}
        lineAnnotations={hunks && hunkAnnotations(fileDiff, hunks)}
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
        renderHeaderFilenameSuffix={() => (
          <CopyButton
            value={fileDiff.name}
            label={`Copy ${fileDiff.name}`}
            size="xs"
          />
        )}
      />
      {binary &&
        (media || (
          <div className="pt-2">
            <EmptyPanel>Binary file, not shown.</EmptyPanel>
          </div>
        ))}
    </div>
  );
}
