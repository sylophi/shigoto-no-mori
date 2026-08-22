import { useEffect, useRef, useState, type ReactNode } from "react";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off — `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { flushSync } from "react-dom";
import { ChevronDown, Loader2, PanelLeft } from "lucide-react";
import { useElementWidth } from "@/hooks/ui/useElementWidth";
import { useTheme } from "@/hooks/ui/useTheme";
import { BackButton } from "@/components/ui/back-button";
import { ChipButton } from "@/components/ui/chip-button";
import { isBareKeyEvent } from "@/lib/dom";
import { cn } from "@/lib/utils";
import { DiffFileIndex } from "./DiffFileIndex";
import { DiffStyleToggle, type DiffStyle } from "./DiffStyleToggle";
import { fileKey } from "./patchFiles";
import { fileTargets, useFileScrollSpy } from "./useFileScrollSpy";
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
// The rail is 288px. Below MIN the diff is left too narrow to read a
// hunk without wrapping, so the rail isn't offered at all. Between MIN
// and AMPLE it's offered but stays shut unless you ask for it: opening
// by default there trades away width the diff still needs. At AMPLE the
// diff keeps ~736px with the rail out, which fits a wide unified hunk.
const INDEX_MIN_PANE = 672;
const INDEX_AMPLE_PANE = 1024;
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

// What landing on a file means, in one place: the rail's clicks and the
// `[` / `]` keys both come through here. Module-level and taking the
// (stable) state setters, so the key listener can call it without
// re-registering on every render.
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
}: {
  patch: string | undefined;
  isLoading: boolean;
  error: Error | null;
  onBack: () => void;
  backLabel: string;
  title: ReactNode;
  subtitle: ReactNode;
  emptyMessage: ReactNode;
}) {
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [indexPref, setIndexPref] = useState(readStoredIndexPref);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paneRef, paneWidth] = useElementWidth<HTMLDivElement>();
  // Pierre's library picks between the `dark`/`light` entries off the
  // shadow root's `color-scheme`, which defaults to the OS preference.
  // Force it to follow the in-app theme instead.
  const { resolved } = useTheme();

  const parsedPatches = patch ? parsePatchFiles(patch) : [];
  const allFiles = parsedPatches.flatMap((p) => p.files);
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
  const indexAvailable =
    allFiles.length >= INDEX_MIN_FILES &&
    paneWidth !== null &&
    paneWidth >= INDEX_MIN_PANE;
  const showIndex =
    indexAvailable && (indexPref ?? paneWidth >= INDEX_AMPLE_PANE);
  const allCollapsed =
    allFiles.length > 0 && collapsedKeys.size >= allFiles.length;

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

  const jumpTo = (key: string) => {
    const container = scrollRef.current;
    if (container) jumpToFile(container, key, setCollapsedKeys, setActiveKey);
  };

  // `[` / `]` step through the files without reaching for the rail (and
  // work even when it's hidden). Bare keys, so they stay inert while the
  // filter box or any other field has focus, and while an overlay covers
  // the page -- neither the launcher nor a modal traps focus, so without
  // that guard they'd scroll the diff hidden behind them. The handler
  // only picks the neighbouring key. jumpToFile stays the single
  // definition of what landing on a file does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (!isBareKeyEvent(e)) return;
      const container = scrollRef.current;
      if (!container) return;
      const keys = fileTargets(container).map((el) => el.dataset["diffFile"]);
      if (keys.length === 0) return;
      e.preventDefault();
      // No active file yet (nothing scrolled) steps to the first one.
      const at = keys.indexOf(activeKey ?? undefined);
      const step = e.key === "]" ? 1 : -1;
      const next = keys[Math.min(keys.length - 1, Math.max(0, at + step))];
      if (next !== undefined)
        jumpToFile(container, next, setCollapsedKeys, setActiveKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeKey, setActiveKey]);

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
                title={
                  showIndex
                    ? "Hide file index"
                    : "Show file index ([ and ] step through files)"
                }
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
            files={allFiles}
            activeKey={activeKey}
            collapsedKeys={collapsedKeys}
            allCollapsed={allCollapsed}
            onSelect={jumpTo}
            onToggleAll={() =>
              setCollapsedKeys(
                allCollapsed ? new Set() : new Set(allFiles.map(fileKey)),
              )
            }
          />
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
              {emptyMessage}
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
                    collapsed={collapsedKeys.has(key)}
                    diffStyle={diffStyle}
                    themeType={resolved}
                    onToggle={setCollapsed}
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
  onToggle: (key: string, collapsed: boolean) => void;
}) {
  return (
    <div data-diff-file={fileId}>
      {/* `PatchDiff` requires a single-file patch. For multi-file output
          we parse with `parsePatchFiles` and spawn one `<FileDiff>` per
          file per the library's recommended pattern. */}
      <FileDiff
        fileDiff={fileDiff}
        options={{ ...DIFF_THEME, diffStyle, themeType, collapsed }}
        renderHeaderPrefix={() => (
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
        )}
      />
    </div>
  );
}
