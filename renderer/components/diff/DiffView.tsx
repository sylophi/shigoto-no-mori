import { useEffect, useRef, useState, type ReactNode } from "react";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off — `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { flushSync } from "react-dom";
import { ChevronDown, Loader2, PanelLeft } from "lucide-react";
import { useElementWidth } from "@/hooks/ui/useElementWidth";
import { useResizableWidth } from "@/hooks/ui/useResizableWidth";
import { useTheme } from "@/hooks/ui/useTheme";
import { BackButton } from "@/components/ui/back-button";
import { ChipButton } from "@/components/ui/chip-button";
import { cn } from "@/lib/utils";
import type { DiffChangesControls } from "./changesControls";
import { DiffFileIndex } from "./DiffFileIndex";
import { DiffStyleToggle, type DiffStyle } from "./DiffStyleToggle";
import { changeEntries, fileKey, patchEntries } from "./patchFiles";
import { useFileScrollSpy } from "./useFileScrollSpy";
import { CenteredMessage } from "@/components/ui/centered-message";
import { readStored, writeStored } from "@/lib/localStorage";

const DIFF_THEME = {
  theme: { dark: "pierre-dark", light: "pierre-light" } as const,
  // 'simple' is the shortest built-in separator (vs 'line-info' default
  // which renders rounded corners and an expansion-control row).
  hunkSeparators: "simple" as const,
  // Pin the diff's base bg to the app's `--background` token. All the
  // per-row backgrounds (buffer, context, separator) derive from
  // `--diffs-bg` via color-mix, so overriding the one variable
  // cascades through the whole diff surface. Without this the diff
  // reads as a pitch-black slab against the lifted neutral-900 main
  // pane that PR #59 introduced. `unsafeCSS` is the documented path
  // for CSS overrides — see https://diffs.com/docs (Hunk Separators).
  unsafeCSS: `:host { --diffs-bg: var(--background); }`,
};

// CSS custom properties inherit through the library's shadow DOM, so
// setting them on the wrapper applies to every FileDiff child.
const DIFF_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "1.45",
  "--diffs-gap-block": "4px",
  "--diffs-gap-inline": "6px",
} as React.CSSProperties;

// Below this a patch is its own table of contents: two files scroll past
// in one flick, and a rail would cost more width than it saves.
const INDEX_MIN_FILES = 3;
// The rail is dragged between these; 288 is where it starts. The upper
// one is a flat ceiling -- the pane lowers it further (see railMax).
const RAIL_MIN = 220;
const RAIL_MAX = 600;
const RAIL_DEFAULT = 288;
// Below MIN the diff beside the rail is too narrow to read a hunk
// without wrapping, so the rail isn't offered at all. Between MIN and
// AMPLE it's offered but stays shut unless you ask for it: opening by
// default there trades away width the diff still needs. At AMPLE the
// diff keeps a width that fits a wide unified hunk. Both are measured
// as what the diff would keep with the rail out, so a wider rail asks
// for a wider pane -- and MIN doubles as the rail's drag ceiling, since
// dragging into it is the one way a rail already open could stop
// fitting.
const DIFF_MIN_BESIDE_RAIL = 384;
const DIFF_AMPLE_BESIDE_RAIL = 736;
// Matches the scroll area's p-2, so a jumped-to file lands where it
// would sit if you had scrolled it to the top yourself.
const JUMP_GAP = 8;
const INDEX_KEY = "diff.fileIndex";

function scrollToFile(container: HTMLElement, target: HTMLElement): void {
  container.scrollTop +=
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    JUMP_GAP;
}

type CollapsedKeys = ReadonlySet<string>;

// Fold-set updater. Returns the same Set when nothing moves, so a no-op
// toggle doesn't re-render the patch.
function withCollapsed(
  prev: CollapsedKeys,
  key: string,
  collapsed: boolean,
): CollapsedKeys {
  if (prev.has(key) === collapsed) return prev;
  const next = new Set(prev);
  if (collapsed) next.add(key);
  else next.delete(key);
  return next;
}

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
  flushSync(() => setCollapsedKeys((prev) => withCollapsed(prev, key, false)));
  scrollToFile(container, target);
  // Claim the highlight immediately. The observer confirms it on the
  // next frame rather than trailing the jump.
  setActiveKey(key);
}

// Three states, not two: null means the user has never said, and the
// pane width decides. Storing a default up-front would freeze whichever
// width the diff happened to be opened at first.
function readStoredIndexPref(): boolean | null {
  const stored = readStored(INDEX_KEY);
  return stored === null ? null : stored !== "0";
}

export function DiffView({
  patch,
  isLoading,
  error,
  onBack,
  backLabel,
  title,
  subtitle,
  emptyMessage,
  changes,
  railFooter,
}: {
  patch: string | undefined;
  isLoading: boolean;
  error: Error | null;
  onBack: () => void;
  backLabel: string;
  title: ReactNode;
  subtitle: ReactNode;
  emptyMessage: ReactNode;
  // Present on the uncommitted-changes page only. Turns the rail into
  // a tick list with the commit composer under it, puts a checkbox in
  // every file header, and keeps the rail on screen regardless of file
  // count or pane width -- there is nowhere else to commit from.
  changes?: DiffChangesControls;
  // Mounted at the foot of the rail: the commit composer.
  railFooter?: ReactNode;
}) {
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [indexPref, setIndexPref] = useState(readStoredIndexPref);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paneRef, paneWidth] = useElementWidth<HTMLDivElement>();
  // The drag stops where the diff's own minimum starts. Without this
  // ceiling a drag past it fails the availability check below and the
  // rail closes under the pointer -- the pane has to be able to hold
  // both, and the rail is the half being dragged. Unmeasured panes
  // (first frame) get the flat ceiling; the measurement follows.
  const railMax =
    paneWidth === null
      ? RAIL_MAX
      : Math.max(
          RAIL_MIN,
          Math.min(RAIL_MAX, paneWidth - DIFF_MIN_BESIDE_RAIL),
        );
  const rail = useResizableWidth({
    storageKey: "diff.railWidth",
    min: RAIL_MIN,
    max: railMax,
    fallback: RAIL_DEFAULT,
    leftEdge: () => paneRef.current?.getBoundingClientRect().left ?? 0,
  });
  // Pierre's library picks between the `dark`/`light` entries off the
  // shadow root's `color-scheme`, which defaults to the OS preference.
  // Force it to follow the in-app theme instead.
  const { resolved } = useTheme();

  const parsedPatches = patch ? parsePatchFiles(patch) : [];
  // Path order, always. Git already emits commits and PRs that way. The
  // working-tree patch does not (untracked files trail the tracked
  // diff), and there ticking a file would otherwise move it -- staging
  // an untracked file promotes it into the tracked half of the patch.
  const allFiles = parsedPatches
    .flatMap((p) => p.files)
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const filesKey = allFiles.map(fileKey).join("\n");
  const [activeKey, setActiveKey] = useFileScrollSpy(scrollRef, filesKey);

  // Fold state is keyed by path, so it can only survive a patch whose
  // file set is unchanged (a worktree diff refetching after an edit).
  // A different set of files is a different reading session.
  const [seenFilesKey, setSeenFilesKey] = useState(filesKey);
  if (seenFilesKey !== filesKey) {
    setSeenFilesKey(filesKey);
    setCollapsedKeys(new Set());
  }

  // Unmeasured (null) counts as too narrow, so the rail can't flash in
  // and back out on the first frame of a diff opened in a narrow pane.
  // The changes page overrides all of it: its rail is the page, and it
  // stays up on a clean tree too, since amending and undoing the last
  // commit live there.
  const railForced = changes !== undefined;
  const indexAvailable =
    !railForced &&
    allFiles.length >= INDEX_MIN_FILES &&
    paneWidth !== null &&
    paneWidth >= rail.width + DIFF_MIN_BESIDE_RAIL;
  const showIndex =
    railForced ||
    (indexAvailable &&
      (indexPref ?? paneWidth >= rail.width + DIFF_AMPLE_BESIDE_RAIL));
  const allCollapsed =
    allFiles.length > 0 && collapsedKeys.size >= allFiles.length;

  // What the rail lists. A read-only diff has only the patch to go on.
  // The changes page has git status too, and that is the list it shows:
  // it is what the commit button acts on, so a file it leaves out is a
  // file you cannot tick, discard, or even see is there. The patch and
  // the status disagree in both directions (git pairs a staged addition
  // with an unstaged deletion into one rename entry; a patch fetched a
  // moment ago has yet to hear about the newest edit), and only one of
  // them is the working tree as the commit will take it.
  const indexEntries = changes
    ? changeEntries(changes.files)
    : patchEntries(allFiles);

  // The changes page hands over one file's diff -- the one its rail has
  // picked -- so the pane draws whatever it was given and the two can't
  // describe different moments. A commit or PR diff hands over the
  // whole patch and reads as one scroll.
  const onePerPick = changes !== undefined;

  // A fresh file starts at its own top, not at the scroll the last one
  // was left at.
  useEffect(() => {
    if (onePerPick) scrollRef.current?.scrollTo({ top: 0 });
  }, [onePerPick, patch]);

  // Toggles against what's on screen, not against the stored preference:
  // in the auto state those differ, and a chip that needs two clicks to
  // do anything the first time reads as broken.
  const toggleIndex = () => {
    const next = !showIndex;
    setIndexPref(next);
    // The stored value is computed before the try: a conditional inside
    // one makes React Compiler bail on this whole component, and without
    // its memo cache the patch is re-parsed on every render.
    writeStored(INDEX_KEY, next ? "1" : "0");
  };

  const setCollapsed = (key: string, collapsed: boolean) =>
    setCollapsedKeys((prev) => withCollapsed(prev, key, collapsed));

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
  // Which row the rail marks: the picked path, or whatever the scroll
  // has reached in a combined read.
  const currentKey = changes ? changes.selectedPath : activeKey;

  return (
    // Measured rather than left to a container query: the chip has to
    // know whether the rail is currently on screen to toggle the right
    // way. (Why the pane and not the window: see useElementWidth.)
    <div ref={paneRef} className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label={backLabel} />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="truncate text-xl font-medium tracking-tight select-text">
              {title}
            </h1>
            <p className="truncate text-xs text-muted-foreground select-text">
              {subtitle}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-center">
            {indexAvailable && (
              <ChipButton
                onClick={toggleIndex}
                aria-pressed={showIndex}
                title={showIndex ? "Hide file index" : "Show file index"}
                aria-label={showIndex ? "Hide file index" : "Show file index"}
                className={cn("py-1.5", showIndex && "text-foreground")}
              >
                <PanelLeft aria-hidden className="size-3.5" />
              </ChipButton>
            )}
            <DiffStyleToggle value={diffStyle} onChange={setDiffStyle} />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {showIndex && (
          <DiffFileIndex
            entries={indexEntries}
            activeKey={currentKey}
            collapsedKeys={collapsedKeys}
            // Folding is a combined-read affordance: with one file in
            // the pane there is nothing for it to collapse.
            allCollapsed={onePerPick ? undefined : allCollapsed}
            onSelect={selectFile}
            onToggleAll={
              onePerPick
                ? undefined
                : () =>
                    setCollapsedKeys(
                      allCollapsed ? new Set() : new Set(allFiles.map(fileKey)),
                    )
            }
            changes={changes}
            footer={railFooter}
            width={rail.width}
          />
        )}
        {showIndex && (
          <div
            onMouseDown={rail.onMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file list"
            tabIndex={-1}
            className="relative w-px shrink-0 cursor-col-resize bg-border"
          >
            <div className="absolute inset-y-0 -left-1 w-2" />
          </div>
        )}

        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-background"
        >
          {isLoading ? (
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
              {/* A picked file with no patch of its own -- a mode
                  change, or content git won't diff -- is not the same
                  as a clean tree, and mustn't borrow its wording. */}
              {onePerPick && changes.files.length > 0
                ? "No text changes to show for this file."
                : emptyMessage}
            </CenteredMessage>
          ) : (
            <div
              data-slot="diff-view"
              className="flex flex-col gap-2 p-2 select-text"
              style={DIFF_STYLE}
            >
              {allFiles.map((fileDiff) => {
                const key = fileKey(fileDiff);
                return (
                  <DiffFileRow
                    key={key}
                    fileDiff={fileDiff}
                    fileId={key}
                    collapsed={!onePerPick && collapsedKeys.has(key)}
                    diffStyle={diffStyle}
                    themeType={resolved}
                    // No fold control in a picker: the file in the pane
                    // is the one you asked for, and folding it away
                    // would leave the pane blank with nothing to
                    // unfold it from.
                    onToggle={onePerPick ? undefined : setCollapsed}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// One file of the patch. Its own component so folding a file re-renders
// that file and not the other 130: pierre's FileDiff re-runs a full DOM
// render on every pass (its instance effect has no dependency array, and
// a collapsed instance never takes the cheap early return), so the
// untouched rows have to keep their cached element to stay free. That
// holds only while every prop here is stable per file -- hence `onToggle`
// is the caller's own setter rather than a per-row closure.
//
// The wrapper is what the index scrolls to and what the scroll spy
// observes. `collapsed` is pierre's own option, which drops the file's
// rendered rows and keeps the header, so folding a file also stops
// paying for it.
//
function DiffFileRow({
  fileDiff,
  fileId,
  collapsed,
  diffStyle,
  themeType,
  onToggle,
}: {
  fileDiff: FileDiffMetadata;
  fileId: string;
  collapsed: boolean;
  diffStyle: DiffStyle;
  themeType: "light" | "dark";
  // Absent in a picker, where there is nothing to fold away -- and with
  // it the header prefix, which then has nothing to draw.
  onToggle: ((key: string, collapsed: boolean) => void) | undefined;
}) {
  return (
    <div data-diff-file={fileId}>
      {/* `PatchDiff` requires a single-file patch. For multi-file output
          we parse with `parsePatchFiles` and spawn one `<FileDiff>` per
          file per the library's recommended pattern. */}
      <FileDiff
        fileDiff={fileDiff}
        options={{ ...DIFF_THEME, diffStyle, themeType, collapsed }}
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
