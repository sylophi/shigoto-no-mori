import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off: `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  parsePatchFiles,
  Virtualizer,
  type FileDiffMetadata,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import { flushSync } from "react-dom";
import { ChevronDown, Files, Loader2, WrapText } from "lucide-react";
import { useTheme } from "@/hooks/ui/useTheme";
import { useWorktreeName } from "@/hooks/worktrees/useWorktreeTitle";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { PAGE_HEADER_PADDING } from "@/components/shared/PageHeader";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import { BackButton } from "@/components/ui/back-button";
import { ChipButton } from "@/components/ui/chip-button";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";
import type { DiffChangesControls } from "./changesControls";
import {
  CODE_GAP_BLOCK,
  CODE_LINE_HEIGHT,
  CODE_STYLE,
  CODE_THEME,
} from "./codeTheme";
import { DiffFileIndex } from "./DiffFileIndex";
import { HunkBar, hunkAnnotations, type HunkControls } from "./HunkBar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { changeEntries, fileKey, patchEntries } from "@/lib/patchFiles";
import { useFileScrollSpy } from "./useFileScrollSpy";
import { CenteredMessage } from "@/components/ui/centered-message";
import { withMember } from "@/lib/toggleSet";
import { readStored, writeStored } from "@/lib/localStorage";

type DiffStyle = "unified" | "split";

// Kept across diffs and launches: whether long lines fit the pane is a
// reading habit, not a property of one patch.
const WRAP_STORAGE_KEY = "diff.wrapLines";

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

// Below this a patch is its own table of contents on a phone: two files
// scroll past in one flick, so the header offers no sheet for them. The
// sidebar's list costs the diff no width, so a wide viewport always has
// it.
const SHEET_MIN_FILES = 3;
// Matches the scroll area's p-2, so a jumped-to file lands where it
// would sit if you had scrolled it to the top yourself.
const JUMP_GAP = 8;

function scrollToFile(container: HTMLElement, target: HTMLElement): void {
  container.scrollTop +=
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    JUMP_GAP;
}

type CollapsedKeys = ReadonlySet<string>;

// What landing on a file means in a combined read: expand it, put it at
// the top of the view, and take the highlight.
function jumpToFile(
  container: HTMLElement,
  key: string,
  setCollapsedKeys: React.Dispatch<React.SetStateAction<CollapsedKeys>>,
  setActiveKey: (key: string) => void,
): void {
  const target = container.querySelector<HTMLElement>(
    `[data-diff-file="${CSS.escape(key)}"]`,
  );
  if (!target) return;
  // Expand first, and commit it before measuring anything: scrollTop is
  // clamped against the current scrollHeight, so on a folded-up patch
  // there is nothing to scroll into yet and the last files would land
  // partway down the view instead of at the top. flushSync is what makes
  // the growth visible to the scroll below. The wrapper node survives
  // the re-render, so `target` stays good.
  flushSync(() => setCollapsedKeys((prev) => withMember(prev, key, false)));
  scrollToFile(container, target);
  // Claim the highlight immediately. The observer confirms it on the
  // next frame rather than trailing the jump.
  setActiveKey(key);
}

// The patch's files, in path order, which is how git emits a commit or
// a PR anyway, so the sort only ever settles a tie. Opted into the
// compiler by hand: inline in DiffView it left this parse uncached (its
// range crosses the scroll spy's hook call), and a hook that calls no
// hooks isn't compiled unless asked. Uncached, every render, each scroll
// spy step included, handed every row a new fileDiff that pierre redraws
// and re-highlights.
function usePatchFiles(patch: string | undefined): FileDiffMetadata[] {
  "use memo";
  const parsed = patch ? parsePatchFiles(patch) : [];
  return parsed
    .flatMap((p) => p.files)
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function DiffView({
  diff,
  onBack,
  worktree,
  title,
  subtitle,
  emptyMessage,
  changes,
  footer,
  details,
  steps,
}: {
  // The patch's read, whichever of the three pages asked for it.
  diff: UseQueryResult<string>;
  onBack: () => void;
  // The worktree the back button returns to, named as its page is.
  worktree: Worktree;
  title: ReactNode;
  subtitle: ReactNode;
  emptyMessage: ReactNode;
  // Present on the uncommitted-changes page only. Turns the file list into a
  // tick list with the commit composer under it, and keeps the list up
  // on a clean tree too, since amending and undoing the last commit
  // live there.
  changes?: DiffChangesControls;
  // Mounted at the foot of the file list: the commit composer.
  footer?: ReactNode;
  // Under the title, the header's width: a commit's message and moves.
  details?: ReactNode;
  // Beside the view's own controls: a commit's steps to its neighbours.
  steps?: ReactNode;
}) {
  const { data: patch, isLoading, error } = diff;
  const backLabel = useWorktreeName(worktree);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [wrapLines, setWrapLines] = useState(
    () => readStored(WRAP_STORAGE_KEY) === "true",
  );
  const toggleWrap = () => {
    const next = !wrapLines;
    setWrapLines(next);
    writeStored(WRAP_STORAGE_KEY, String(next));
  };
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Draws only the rows near the view, in every file of the patch: a
  // commit that touches hundreds of files, or a lockfile on its own,
  // otherwise puts every row in the DOM up front and holds the window
  // for seconds. The file wrappers keep their full height, so the
  // scrollbar, the index's jumps and the scroll spy work as before.
  const [virtualizer] = useState(() => new Virtualizer());
  // Armed on the list rather than the scroll area: the list is what
  // grows, and it only exists once there is a patch to show. The rows'
  // own refs run first and queue up until this connects them. The
  // scroll area is read off the DOM, not scrollRef: when both mount in
  // one commit (a cached diff reopened), this ref runs before the
  // parent's is set.
  const listRef = (list: HTMLDivElement | null) => {
    const scroller = list?.parentElement;
    if (list && scroller) virtualizer.setup(scroller, list);
    else virtualizer.cleanUp();
  };
  // The file list lives in the app sidebar (SidebarTakeover), which a
  // phone doesn't have. The same list opens as a bottom sheet there instead.
  const phone = usePhoneLayout();
  const [fileSheetOpen, setFileSheetOpen] = useState(false);
  // Pierre's library picks between the `dark`/`light` entries off the
  // shadow root's `color-scheme`, which defaults to the OS preference.
  // Force it to follow the in-app theme instead.
  const { resolved } = useTheme();

  // Which of the two views this is. The changes page hands over one
  // file's diff, the one its list picked, so the pane draws what it was
  // given, holds no fold state and needs no scroll spy. A commit or PR
  // diff hands over the whole patch, reads as one scroll, and its list
  // is a map of that scroll.
  const singleFile = changes !== undefined;
  const filesLabel = singleFile ? "Changed files" : "Files in this patch";

  const allFiles = usePatchFiles(patch);
  const filesKey = allFiles.map(fileKey).join("\n");
  const [activeKey, setActiveKey] = useFileScrollSpy(
    scrollRef,
    filesKey,
    !singleFile,
  );

  // Fold state is keyed by path, so it can only survive a patch whose
  // file set is unchanged (a commit diff re-rendering). A different set
  // of files is a different reading session.
  const [seenFilesKey, setSeenFilesKey] = useState(filesKey);
  if (seenFilesKey !== filesKey) {
    setSeenFilesKey(filesKey);
    if (collapsedKeys.size > 0) setCollapsedKeys(new Set());
  }

  // A read-only patch lists its files once there are some. Until then
  // the pane says why there aren't, and the sidebar holds just the way
  // back rather than an empty list that would read as a clean patch.
  const showIndex = singleFile || allFiles.length > 0;
  const allCollapsed =
    allFiles.length > 0 && collapsedKeys.size >= allFiles.length;
  const toggleAll = () =>
    setCollapsedKeys(allCollapsed ? new Set() : new Set(allFiles.map(fileKey)));

  // What the file list holds: the patch's files on a read-only diff, git
  // status on the changes page.
  const indexEntries = changes
    ? changeEntries(changes.files)
    : patchEntries(allFiles);

  // A fresh file starts at its own top, not at the scroll the last one
  // was left at.
  useEffect(() => {
    if (singleFile) scrollRef.current?.scrollTo({ top: 0 });
  }, [singleFile, patch]);

  const setCollapsed = (key: string, collapsed: boolean) =>
    setCollapsedKeys((prev) => withMember(prev, key, collapsed));

  // What landing on a file means: the changes page fetches it, a
  // combined read scrolls to it.
  const selectFile = (key: string) => {
    if (changes) {
      changes.onSelect(key);
      return;
    }
    const container = scrollRef.current;
    if (container) jumpToFile(container, key, setCollapsedKeys, setActiveKey);
  };
  // Which row the list marks: the picked path, or whatever the scroll
  // has reached in a combined read.
  const currentKey = changes ? changes.selectedKey : activeKey;
  // What the sidebar's list and the phone's sheet both draw.
  const indexProps = {
    entries: indexEntries,
    activeKey: currentKey,
    collapsedKeys,
    allCollapsed,
    // Folding is a combined-read affordance: with one file in the pane
    // there is nothing for it to collapse, so the header drops the
    // control with its handler.
    onToggleAll: singleFile ? undefined : toggleAll,
    changes,
    footer,
  };

  return (
    <div className="flex h-full flex-col">
      <SidebarTakeover back={{ label: backLabel, onClick: onBack }}>
        {showIndex && (
          <DiffFileIndex
            {...indexProps}
            onSelect={selectFile}
            className="min-h-0 flex-1"
          />
        )}
      </SidebarTakeover>
      <header
        className={cn(
          "flex flex-col gap-3 border-b border-border",
          PAGE_HEADER_PADDING,
        )}
      >
        {/* A wide viewport's way back is the sidebar's first row. */}
        {phone && <BackButton onClick={onBack} label={backLabel} />}
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            {/* A phone's header row is shared with the chips, so the
                title wraps there instead of losing its tail. */}
            <h1 className="truncate text-xl font-medium tracking-tight select-text phone:text-lg phone:whitespace-normal">
              {title}
            </h1>
            <p className="truncate text-xs text-muted-foreground select-text">
              {subtitle}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-center">
            {steps}
            {phone && (singleFile || allFiles.length >= SHEET_MIN_FILES) && (
              <ChipButton
                onClick={() => setFileSheetOpen(true)}
                aria-label={`${filesLabel} (${indexEntries.length})`}
                className="py-1.5"
              >
                <Files aria-hidden className="size-3.5" />
                <span className="tabular">{indexEntries.length}</span>
              </ChipButton>
            )}
            <SimpleTooltip tip="Wrap long lines">
              <IconButton
                onClick={toggleWrap}
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
              onChange={setDiffStyle}
              options={DIFF_STYLE_OPTIONS}
            />
          </div>
        </div>
        {details}
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-auto bg-background"
      >
        {/* Until the status list answers, an empty pane would read as
            a clean tree. */}
        {isLoading || changes?.loading ? (
          <CenteredMessage>
            <Loader2 aria-hidden className="mr-2 size-3.5 animate-spin" />
            Computing diff…
          </CenteredMessage>
        ) : error ? (
          <CenteredMessage className="px-6">
            Couldn't compute diff.
          </CenteredMessage>
        ) : allFiles.length === 0 ? (
          <CenteredMessage className="px-6 text-center">
            {/* A picked file with no patch of its own (a mode change,
                  or content git won't diff) is not a clean tree and
                  mustn't borrow its wording. */}
            {singleFile && changes.files.length > 0
              ? "No text changes to show for this file."
              : emptyMessage}
          </CenteredMessage>
        ) : (
          <div
            ref={listRef}
            data-slot="diff-view"
            className="flex flex-col gap-2 p-2 select-text"
            style={CODE_STYLE}
          >
            <VirtualizerContext value={virtualizer}>
              {allFiles.map((fileDiff) => {
                const key = fileKey(fileDiff);
                return (
                  <DiffFileRow
                    key={key}
                    fileDiff={fileDiff}
                    fileId={key}
                    collapsed={!singleFile && collapsedKeys.has(key)}
                    diffStyle={diffStyle}
                    wrapLines={wrapLines}
                    themeType={resolved}
                    // No fold control on a single file: it is the one
                    // you asked for, and folding it away would leave
                    // the pane blank with nothing to unfold it from.
                    onToggle={singleFile ? undefined : setCollapsed}
                    hunks={changes?.hunks}
                    busy={changes?.busy ?? false}
                  />
                );
              })}
            </VirtualizerContext>
          </div>
        )}
      </div>

      {phone && (
        <Sheet open={fileSheetOpen} onOpenChange={setFileSheetOpen}>
          {/* The file list as a bottom sheet: a patch is still easier to
              read with its map to hand. Picking a file closes the
              sheet and jumps, so the tap lands on the file itself. */}
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="gap-0 p-0"
          >
            <SheetTitle className="sr-only">{filesLabel}</SheetTitle>
            <DiffFileIndex
              {...indexProps}
              onSelect={(key) => {
                setFileSheetOpen(false);
                selectFile(key);
              }}
              className="h-[70dvh] w-full"
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
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
function DiffFileRow({
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
                <HunkBar
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
