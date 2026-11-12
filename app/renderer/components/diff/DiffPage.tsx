import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off: `@pierre/diffs/react` only re-exports the React
// components and shared types).
import {
  parsePatchFiles,
  Virtualizer,
  type FileDiffMetadata,
} from "@pierre/diffs";
// oxlint-disable-next-line import/default -- vite's ?worker import is the worker's constructor
import PatchFilesWorker from "./patchFiles.worker.ts?worker";
import { useLook } from "@/hooks/ui/useLook";
import { useWorktreeName } from "@/hooks/worktrees/useWorktreeTitle";
import { useClaimPageBack } from "@/hooks/ui/usePageBack";
import { useOpenInEditor } from "@/hooks/launchers/useLaunchers";
import { useDiffSides } from "@/hooks/worktrees/useWorktreeFile";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import type { Worktree } from "@shigomori/contracts/schemas";
import type { DiffChangesControls } from "@shigomori/ui/views/diff/changesControls.ts";
import {
  DiffFileRowView,
  DiffFilesSheetView,
  DiffHeaderView,
  DiffPageView,
  DiffPaneView,
  type DiffStyle,
} from "@shigomori/ui/views/diff/DiffPageView.tsx";
import {
  changeEntries,
  fileKey,
  isMediaBinary,
  namesBlobsInFull,
  patchEntries,
} from "@shigomori/ui/lib/patchFiles.ts";
import { DiffFileIndex } from "./DiffFileIndex";
import { HighlightWorkers } from "./HighlightWorkers";
import { MediaDiff } from "./MediaDiff";
import { useDiffFind } from "./useDiffFind";
import { readStored, writeStored } from "@/lib/localStorage";

// Kept across diffs and launches: whether long lines fit the pane is a
// reading habit, not a property of one patch.
const WRAP_STORAGE_KEY = "diff.wrapLines";

// From this size a patch is parsed in a worker (patchFiles.worker.ts).
// Pierre parses a megabyte of patch in about 10 ms, less than a
// worker's start, so a smaller one is parsed in place.
const PARSE_IN_WORKER_FROM = 1_000_000;

const NO_FILES: FileDiffMetadata[] = [];

// In path order, which is how git emits a commit or a PR anyway, so the
// sort only ever settles a tie.
const byName = (files: FileDiffMetadata[]) =>
  files.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// The patch's files, or undefined until a worker's first parse answers.
// The parse in place stays cached for the patch: uncached, every
// render would hand every row a new fileDiff, which pierre draws and
// highlights again.
function usePatchFiles(
  patch: string | undefined,
  // Which page the patch is for (one commit, the branch against a base,
  // one picked file), so one page never shows another's files.
  page: string,
): FileDiffMetadata[] | undefined {
  // The patch, when it is a worker's to parse.
  const big =
    patch !== undefined && patch.length >= PARSE_IN_WORKER_FROM
      ? patch
      : undefined;
  // The page's last parse, which stays up while a patch that changed
  // under it (a commit made while it's open) is parsed again, so the
  // page keeps its place.
  const [parsed, setParsed] = useState<{
    page: string;
    files: FileDiffMetadata[];
  }>();
  useEffect(() => {
    if (big === undefined) return;
    const worker = new PatchFilesWorker();
    worker.addEventListener(
      "message",
      (event: MessageEvent<FileDiffMetadata[]>) => {
        setParsed({ page, files: byName(event.data) });
        worker.terminate();
      },
    );
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage takes no origin
    worker.postMessage(big);
    return () => worker.terminate();
  }, [big, page]);
  if (patch === undefined) return NO_FILES;
  if (big === undefined)
    return byName(parsePatchFiles(patch).flatMap((p) => p.files));
  return parsed?.page === page ? parsed.files : undefined;
}

export function DiffPage({
  diff,
  onBack,
  worktree,
  title,
  subtitle,
  subtitleEnd,
  emptyMessage,
  changes,
  footer,
  details,
  renderSidebar,
  sidebarActions,
  retryMedia,
}: {
  // The patch's read, whichever of the three pages asked for it.
  diff: Pick<UseQueryResult<string>, "data" | "isLoading" | "error">;
  // Asks for the patch again, for a media file it names only in short
  // (a pull request's, its commits not fetched here), and whether that
  // ask is out.
  retryMedia?: { readonly retry: () => void; readonly retrying: boolean };
  onBack: () => void;
  // The worktree the back button returns to, named as its page is.
  worktree: Worktree;
  title: ReactNode;
  subtitle: ReactNode;
  subtitleEnd?: ReactNode;
  emptyMessage: ReactNode;
  // Present on the uncommitted-changes page only. Turns the file list into a
  // tick list with the commit composer under it, and keeps the list up
  // on a clean tree too, since amending and undoing the last commit
  // live there. Its list picks the file and fetches that file's patch
  // alone.
  changes?: DiffChangesControls;
  // Mounted at the foot of the file list: the commit composer.
  footer?: ReactNode;
  // Under the title, the header's width: a commit's message and moves.
  details?: ReactNode;
  // What the sidebar (and a phone's sheet) shows around the file list
  // or in its place: the Git page's tabs, which hold this list or a
  // list of their own. Handed the list.
  renderSidebar?: (index: ReactNode) => ReactNode;
  // At the end of the sidebar's back row: the Git page's branch menu.
  sidebarActions?: ReactNode;
}) {
  const { data: patch, isLoading, error } = diff;
  const backLabel = useWorktreeName(worktree);
  useClaimPageBack(backLabel, onBack);
  const openInEditor = useOpenInEditor(worktree);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [wrapLines, setWrapLines] = useState(
    () => readStored(WRAP_STORAGE_KEY) === "true",
  );
  const toggleWrap = () => {
    const next = !wrapLines;
    setWrapLines(next);
    writeStored(WRAP_STORAGE_KEY, String(next));
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  // Draws only the rows of the file near the view: a lockfile otherwise
  // puts every row in the DOM up front and holds the window for seconds.
  // The file keeps its full height, so the pane scrolls as if every row
  // were drawn.
  //
  // The list's ref arms it, on the list rather than the scroll area: the
  // list is what grows, and it only exists once there is a patch to
  // show. The rows' own refs run first and queue up until this connects
  // them. The scroll area is read off the DOM, not scrollRef: when both
  // mount in one commit (a cached diff reopened), this ref runs before
  // the parent's is set. The ref is made once with the virtualizer, not
  // left to the compiler: a new one on a render has React call the old
  // with null, and cleanUp disconnects every row.
  const [{ virtualizer, listRef }] = useState(() => {
    const made = new Virtualizer();
    return {
      virtualizer: made,
      listRef: (list: HTMLDivElement | null) => {
        const scroller = list?.parentElement;
        if (list && scroller) made.setup(scroller, list);
        else made.cleanUp();
      },
    };
  });
  // The file list lives in the app sidebar (SidebarTakeover), which a
  // phone doesn't have. The same list opens as a bottom sheet there instead.
  const phone = usePhoneLayout();
  const [fileSheetOpen, setFileSheetOpen] = useState(false);
  // Pierre's library picks between the `dark`/`light` entries off the
  // shadow root's `color-scheme`, which defaults to the OS preference.
  // Force it to follow the in-app theme instead.
  const { resolved } = useLook();
  const loadSides = useDiffSides(worktree.projectId, worktree.id);

  const filesLabel = changes ? "Changed files" : "Files in this patch";

  // Which patch the page is on. `list` only says what the sidebar
  // shows, so it is no part of that.
  const { pathname, search } = useLocation();
  const page = `${pathname}${JSON.stringify({ ...search, list: undefined })}\n${changes?.selectedKey ?? ""}`;
  const parsedFiles = usePatchFiles(patch, page);
  const allFiles = parsedFiles ?? NO_FILES;

  // The file the pane shows: the one picked from a whole patch's list,
  // kept while the next patch has it too (the same file in the next
  // commit), and otherwise the patch's first, which is the changes
  // page's one.
  const [picked, setPicked] = useState<string | null>(null);
  const shown =
    allFiles.find((file) => fileKey(file) === picked) ?? allFiles[0];
  const shownKey = shown && fileKey(shown);

  // A read-only patch lists its files once there are some. Until then
  // the pane says why there aren't, and the sidebar holds just the way
  // back rather than an empty list that would read as a clean patch.
  const showIndex = changes !== undefined || allFiles.length > 0;

  // What the file list holds: the patch's files on a read-only diff, git
  // status on the changes page.
  const indexEntries = changes
    ? changeEntries(changes.files)
    : patchEntries(allFiles);

  // A fresh file starts at its own top, not at the scroll the last one
  // was left at. A file read again as it changes keeps its place.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page, shownKey]);

  const selectFile = changes?.onSelect ?? setPicked;
  // What the sidebar's list and the phone's sheet both draw.
  const indexProps = {
    entries: indexEntries,
    activeKey: changes ? changes.selectedKey : (shownKey ?? null),
    changes,
    footer,
    onOpen: openInEditor,
    className: "min-h-0 flex-1",
  };
  // The list, framed by the page when it frames it.
  const sidebarWith = (index: ReactNode) =>
    renderSidebar ? renderSidebar(index) : index;

  // Picking a file in the phone's sheet closes it, so the tap lands on
  // the file itself.
  const selectFromSheet = (key: string) => {
    setFileSheetOpen(false);
    selectFile(key);
  };

  const find = useDiffFind({
    scrollRef,
    files: allFiles,
    diffStyle,
    // Only a whole patch has other files to go to.
    toFile: setPicked,
  });

  const row = shown && (
    <DiffFileRowView
      // A renderer of its own per file: pierre keeps the last file's
      // rows up until the next one's are colored, and find would read
      // them as the new file's.
      key={shownKey}
      fileDiff={shown}
      diffStyle={diffStyle}
      wrapLines={wrapLines}
      themeType={resolved}
      hunks={changes?.readOnly ? undefined : changes?.hunks}
      busy={changes?.busy ?? false}
      loadSides={namesBlobsInFull(shown) ? loadSides : undefined}
      media={
        isMediaBinary(shown) && (
          <MediaDiff
            projectId={worktree.projectId}
            worktreeId={worktree.id}
            fileDiff={shown}
            retry={retryMedia}
          />
        )
      }
    />
  );

  return (
    <HighlightWorkers>
      <DiffPageView
        takeover={
          <SidebarTakeover
            back={{ label: backLabel, onClick: onBack }}
            actions={sidebarActions}
          >
            {sidebarWith(
              showIndex && (
                <DiffFileIndex {...indexProps} onSelect={selectFile} />
              ),
            )}
          </SidebarTakeover>
        }
        header={
          <DiffHeaderView
            title={title}
            subtitle={subtitle}
            subtitleEnd={subtitleEnd}
            files={
              phone
                ? {
                    label: filesLabel,
                    count: indexEntries.length,
                    onOpen: () => setFileSheetOpen(true),
                  }
                : null
            }
            find={find.toggle}
            wrapLines={wrapLines}
            onToggleWrap={toggleWrap}
            diffStyle={diffStyle}
            onDiffStyle={setDiffStyle}
            details={details}
          />
        }
        findBar={find.bar}
        pane={
          <DiffPaneView
            scrollRef={scrollRef}
            listRef={listRef}
            // Until the status list answers, or the patch is parsed, an
            // empty pane would read as a clean tree.
            state={
              isLoading || changes?.loading || parsedFiles === undefined
                ? "loading"
                : // A pull request's patch asked again for its media keeps
                  // showing when that ask fails. Any other page says so.
                  error && (patch === undefined || retryMedia === undefined)
                  ? "error"
                  : allFiles.length === 0
                    ? "empty"
                    : "files"
            }
            message={
              // A picked file with no patch of its own (a mode change, or
              // content git won't diff) is not a clean tree and mustn't
              // borrow its wording.
              changes && changes.files.length > 0
                ? "No text changes to show for this file."
                : emptyMessage
            }
            virtualizer={virtualizer}
          >
            {row}
          </DiffPaneView>
        }
        sheet={
          phone && (
            <DiffFilesSheetView
              open={fileSheetOpen}
              onOpenChange={setFileSheetOpen}
              title={filesLabel}
            >
              {sidebarWith(
                showIndex && (
                  <DiffFileIndex {...indexProps} onSelect={selectFromSheet} />
                ),
              )}
            </DiffFilesSheetView>
          )
        }
      />
    </HighlightWorkers>
  );
}
