import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off: `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import {
  parsePatchFiles,
  Virtualizer,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { flushSync } from "react-dom";
import { useTheme } from "@/hooks/ui/useTheme";
import { useWorktreeName } from "@/hooks/worktrees/useWorktreeTitle";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import type { Worktree } from "@shigomori/contracts/schemas";
import type { DiffChangesControls } from "./changesControls";
import { DiffFileIndexView } from "./DiffFileIndexView";
import {
  DiffFileRowView,
  DiffFilesSheetView,
  DiffHeaderView,
  DiffPageView,
  DiffPaneView,
  type DiffStyle,
} from "./DiffPageView";
import { changeEntries, fileKey, patchEntries } from "@/lib/patchFiles";
import { useFileScrollSpy } from "./useFileScrollSpy";
import { withMember } from "@shigomori/ui/lib/toggleSet.ts";
import { readStored, writeStored } from "@/lib/localStorage";

// Kept across diffs and launches: whether long lines fit the pane is a
// reading habit, not a property of one patch.
const WRAP_STORAGE_KEY = "diff.wrapLines";

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

export function DiffPage({
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
  renderSidebar,
  sidebarActions,
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
  // What the sidebar (and a phone's sheet) shows in place of the bare
  // file list: the Git page's tabs, its Changes tab around this list and
  // its History tab in place of it. Handed the list.
  renderSidebar?: (index: ReactNode) => ReactNode;
  // At the end of the sidebar's back row: the Git page's Merge.
  sidebarActions?: ReactNode;
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
  // The list, framed by the page when it frames it.
  const sidebarWith = (index: ReactNode) =>
    renderSidebar ? renderSidebar(index) : index;

  const fileIndex = (onSelect: (key: string) => void) => (
    <DiffFileIndexView
      {...indexProps}
      onSelect={onSelect}
      className="min-h-0 flex-1"
    />
  );

  return (
    <DiffPageView
      takeover={
        <SidebarTakeover
          back={{ label: backLabel, onClick: onBack }}
          actions={sidebarActions}
        >
          {sidebarWith(showIndex && fileIndex(selectFile))}
        </SidebarTakeover>
      }
      header={
        <DiffHeaderView
          title={title}
          subtitle={subtitle}
          back={phone ? { label: backLabel, onClick: onBack } : null}
          steps={steps}
          files={
            phone &&
            (renderSidebar !== undefined ||
              singleFile ||
              allFiles.length >= SHEET_MIN_FILES)
              ? {
                  label: filesLabel,
                  count: indexEntries.length,
                  onOpen: () => setFileSheetOpen(true),
                }
              : null
          }
          wrapLines={wrapLines}
          onToggleWrap={toggleWrap}
          diffStyle={diffStyle}
          onDiffStyle={setDiffStyle}
          details={details}
        />
      }
      pane={
        <DiffPaneView
          scrollRef={scrollRef}
          listRef={listRef}
          // Until the status list answers, an empty pane would read as
          // a clean tree.
          state={
            isLoading || changes?.loading
              ? "loading"
              : error
                ? "error"
                : allFiles.length === 0
                  ? "empty"
                  : "files"
          }
          message={
            // A picked file with no patch of its own (a mode change, or
            // content git won't diff) is not a clean tree and mustn't
            // borrow its wording.
            singleFile && changes.files.length > 0
              ? "No text changes to show for this file."
              : emptyMessage
          }
          virtualizer={virtualizer}
        >
          {allFiles.map((fileDiff) => {
            const key = fileKey(fileDiff);
            return (
              <DiffFileRowView
                key={key}
                fileDiff={fileDiff}
                fileId={key}
                collapsed={!singleFile && collapsedKeys.has(key)}
                diffStyle={diffStyle}
                wrapLines={wrapLines}
                themeType={resolved}
                // No fold control on a single file: it is the one you
                // asked for, and folding it away would leave the pane
                // blank with nothing to unfold it from.
                onToggle={singleFile ? undefined : setCollapsed}
                hunks={changes?.readOnly ? undefined : changes?.hunks}
                busy={changes?.busy ?? false}
              />
            );
          })}
        </DiffPaneView>
      }
      sheet={
        phone && (
          // Picking a file closes the sheet and jumps, so the tap lands
          // on the file itself.
          <DiffFilesSheetView
            open={fileSheetOpen}
            onOpenChange={setFileSheetOpen}
            title={filesLabel}
          >
            {sidebarWith(
              fileIndex((key) => {
                setFileSheetOpen(false);
                selectFile(key);
              }),
            )}
          </DiffFilesSheetView>
        )
      }
    />
  );
}
