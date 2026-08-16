import { useEffect, useRef, useState, type ReactNode } from "react";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off — `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ChevronDown, Loader2, PanelLeft } from "lucide-react";
import { useTheme } from "@/hooks/ui/useTheme";
import { BackButton } from "@/components/ui/back-button";
import { ChipButton } from "@/components/ui/chip-button";
import { isEditableTarget } from "@/lib/dom";
import { cn } from "@/lib/utils";
import { DiffFileIndex } from "./DiffFileIndex";
import { DiffStyleToggle, type DiffStyle } from "./DiffStyleToggle";
import { fileKey } from "./patchFiles";
import { useFileScrollSpy } from "./useFileScrollSpy";

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
// Matches the scroll area's p-2, so a jumped-to file lands where it
// would sit if you had scrolled it to the top yourself.
const JUMP_GAP = 8;
const INDEX_KEY = "diff.fileIndex";

// The file wrappers in scroll order. Read from the DOM rather than from
// a ref registry: the same `data-diff-file` marker already anchors the
// scroll spy, and one marker beats threading a callback ref per file.
function fileTargets(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-diff-file]")];
}

function scrollToFile(container: HTMLElement, target: HTMLElement): void {
  container.scrollTop +=
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    JUMP_GAP;
}

function readStoredIndexOpen(): boolean {
  try {
    return window.localStorage.getItem(INDEX_KEY) !== "0";
  } catch {
    return true;
  }
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
  const [indexOpen, setIndexOpen] = useState(readStoredIndexOpen);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const showIndex = indexOpen && allFiles.length >= INDEX_MIN_FILES;
  const allCollapsed =
    allFiles.length > 0 && collapsedKeys.size >= allFiles.length;

  const toggleIndex = () => {
    const next = !indexOpen;
    setIndexOpen(next);
    try {
      window.localStorage.setItem(INDEX_KEY, next ? "1" : "0");
    } catch {
      // localStorage may be unavailable; not fatal.
    }
  };

  const setCollapsed = (key: string, collapsed: boolean) =>
    setCollapsedKeys((prev) => {
      if (prev.has(key) === collapsed) return prev;
      const next = new Set(prev);
      if (collapsed) next.add(key);
      else next.delete(key);
      return next;
    });

  const jumpTo = (key: string) => {
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-diff-file="${CSS.escape(key)}"]`,
    );
    if (!container || !target) return;
    // Expanding grows the file below its own header, so the header stays
    // where it is and the offset measured now survives the state update.
    setCollapsed(key, false);
    scrollToFile(container, target);
    // Claim the highlight immediately; the observer confirms it on the
    // next frame rather than trailing the jump.
    setActiveKey(key);
  };

  // `[` / `]` step through the files without reaching for the rail (and
  // work even when it's hidden). Bare keys, so they stay inert while the
  // filter box or any other field has focus. The handler deliberately
  // touches only stable setters and the module-level DOM helpers, so the
  // listener is re-registered on active-file changes and nothing else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (e.repeat || e.isComposing) return;
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEditableTarget(e.target)) return;
      const container = scrollRef.current;
      if (!container) return;
      const targets = fileTargets(container);
      if (targets.length === 0) return;
      e.preventDefault();
      const at = targets.findIndex(
        (el) => el.dataset["diffFile"] === activeKey,
      );
      const target =
        targets[
          Math.min(
            targets.length - 1,
            Math.max(0, at + (e.key === "]" ? 1 : -1)),
          )
        ];
      const key = target?.dataset["diffFile"];
      if (!target || key === undefined) return;
      setCollapsedKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      scrollToFile(container, target);
      setActiveKey(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeKey, setActiveKey]);

  return (
    // The rail is a function of how much room this pane actually has,
    // not of the window: the sidebar is user-resizable, so a viewport
    // breakpoint would guess wrong. @container measures the pane itself.
    <div className="@container/diff flex h-full flex-col">
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
            {allFiles.length >= INDEX_MIN_FILES && (
              <ChipButton
                onClick={toggleIndex}
                aria-pressed={indexOpen}
                title={
                  indexOpen
                    ? "Hide file index"
                    : "Show file index ([ and ] step through files)"
                }
                aria-label={indexOpen ? "Hide file index" : "Show file index"}
                className={cn(
                  "hidden py-1.5 @2xl/diff:inline-flex",
                  indexOpen && "text-foreground",
                )}
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
            className="hidden @2xl/diff:flex"
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
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 aria-hidden className="mr-2 size-3.5 animate-spin" />
              Computing diff…
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
              Couldn't compute diff.
            </div>
          ) : allFiles.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            <div
              data-slot="diff-view"
              className="flex flex-col gap-2 p-2 select-text"
              style={DIFF_STYLE}
            >
              {allFiles.map((fileDiff) => {
                const key = fileKey(fileDiff);
                const collapsed = collapsedKeys.has(key);
                return (
                  // `PatchDiff` requires a single-file patch; for multi-file
                  // output we parse with `parsePatchFiles` and spawn one
                  // `<FileDiff>` per file per the library's recommended
                  // pattern. React Compiler memoizes this implicitly.
                  //
                  // The wrapper is what the index scrolls to and what the
                  // scroll spy observes; `collapsed` is pierre's own option,
                  // which drops the file's rendered rows and keeps the
                  // header, so folding a file also stops paying for it.
                  <div key={key} data-diff-file={key}>
                    <FileDiff
                      fileDiff={fileDiff}
                      options={{
                        ...DIFF_THEME,
                        diffStyle,
                        themeType: resolved,
                        collapsed,
                      }}
                      renderHeaderPrefix={() => (
                        <button
                          type="button"
                          onClick={() => setCollapsed(key, !collapsed)}
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
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
