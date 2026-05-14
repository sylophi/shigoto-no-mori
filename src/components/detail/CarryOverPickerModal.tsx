import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy as CopyIcon,
  CornerLeftUp,
  Folder,
  Link as LinkIcon,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { MaterialIcon } from "@/components/ui/material-icon";
import { cn } from "@/lib/utils";
import { useFsListEntries } from "@/hooks/useFsListEntries";
import { useIgnoredPaths } from "@/hooks/useIgnoredPaths";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { tildify } from "@/lib/projectPaths";
import type { CarryOverEntry, FsEntry } from "@shared/schemas";

interface CarryOverPickerModalProps {
  projectId: string;
  projectPath: string;
  selectedPaths: Set<string>;
  onPick: (entry: CarryOverEntry) => void;
  onClose: () => void;
}

// A path is gitignored if it appears in the leaf list directly, if its
// directory form (path + "/") does, or if any ancestor folder is a fully
// ignored directory (entry with trailing slash). Mirrors how `git
// check-ignore` resolves nested paths against `--directory` output.
function makeIgnoreMatcher(paths: string[]): (relative: string) => boolean {
  const set = new Set(paths);
  return (relative) => {
    if (!relative) return false;
    if (set.has(relative)) return true;
    if (set.has(`${relative}/`)) return true;
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (set.has(`${parts.slice(0, i).join("/")}/`)) return true;
    }
    return false;
  };
}

export function CarryOverPickerModal({
  projectId,
  projectPath,
  selectedPaths,
  onPick,
  onClose,
}: CarryOverPickerModalProps) {
  const [cwd, setCwd] = useState(projectPath);
  const [filter, setFilter] = useState("");
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;

  const { data: listing, isLoading, error } = useFsListEntries(cwd);
  const { data: ignoredPaths = [] } = useIgnoredPaths(projectId);
  const isIgnored = makeIgnoreMatcher(ignoredPaths);
  const atRoot = cwd === projectPath;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goUp = () => {
    if (atRoot) return;
    const idx = cwd.lastIndexOf("/");
    if (idx <= 0) return;
    const parent = cwd.slice(0, idx);
    if (parent.length < projectPath.length) return;
    setCwd(parent);
    setFilter("");
  };

  const navigateInto = (name: string) => {
    setCwd(`${cwd}/${name}`);
    setFilter("");
  };

  const relativeFor = (name: string): string => {
    const abs = `${cwd}/${name}`;
    if (abs === projectPath) return "";
    if (abs.startsWith(`${projectPath}/`)) {
      return abs.slice(projectPath.length + 1);
    }
    return abs;
  };

  const pick = (entry: FsEntry, mode: CarryOverEntry["mode"]) => {
    const path = relativeFor(entry.name);
    if (!path) return;
    onPick({ path, mode });
  };

  const trimmed = filter.trim().toLowerCase();
  const entries = (listing?.entries ?? []).filter((e) =>
    trimmed ? e.name.toLowerCase().includes(trimmed) : true,
  );

  // Snap back to the top whenever the visible list shifts under us so the
  // highlight never lands on a stale or out-of-range row.
  useEffect(() => {
    setHighlightedIdx(0);
  }, [cwd, filter]);

  useEffect(() => {
    if (entries.length === 0) return;
    listRef.current
      ?.querySelector(`[data-row-idx="${highlightedIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIdx, entries.length]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIdx((i) =>
        entries.length === 0 ? 0 : Math.min(i + 1, entries.length - 1),
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === "ArrowRight") {
      const target = entries[highlightedIdx];
      if (target?.isDirectory) {
        e.preventDefault();
        navigateInto(target.name);
      }
      return;
    }
    if (e.key === "ArrowLeft" && filter === "" && !atRoot) {
      e.preventDefault();
      goUp();
    }
  };

  // Tildify only when above home; otherwise show project-relative path so
  // the user sees where they are inside the repo.
  const breadcrumb = atRoot
    ? tildify(cwd, home)
    : `${tildify(projectPath, home)}${cwd.slice(projectPath.length)}`;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/40 p-4 pt-[10vh] backdrop-blur-[2px]"
    >
      <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          {!atRoot && (
            <button
              type="button"
              onClick={goUp}
              aria-label="Go up"
              title="Go up"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <Folder className="size-4 shrink-0 text-muted-foreground/80" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-sm select-text"
            title={cwd}
          >
            {breadcrumb}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close picker"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex items-center gap-1.5 border-b border-border bg-card/40 px-3 py-1.5">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Filter"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- picker just opened
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
        </div>

        <div className="max-h-[60vh] min-h-[12rem] overflow-y-auto p-1">
          {!atRoot && (
            <button
              type="button"
              onClick={goUp}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CornerLeftUp className="size-3.5" />
              <span className="font-mono">..</span>
            </button>
          )}

          {isLoading && !listing ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading...
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-xs text-destructive">
              {error.message}
            </div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {trimmed
                ? `No entries matching "${trimmed}".`
                : atRoot
                  ? "Project root is empty."
                  : "Empty folder."}
            </div>
          ) : (
            <ul ref={listRef} className="divide-y divide-border/40">
              {entries.map((entry, idx) => {
                const relative = relativeFor(entry.name);
                const ignored = isIgnored(relative);
                const added = selectedPaths.has(relative);
                return (
                  <PickerRow
                    key={entry.name}
                    entry={entry}
                    added={added}
                    ignored={ignored}
                    index={idx}
                    highlighted={idx === highlightedIdx}
                    onNavigate={() => navigateInto(entry.name)}
                    onHover={() => setHighlightedIdx(idx)}
                    onPick={(mode) => pick(entry, mode)}
                  />
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <KbdGroup>
            <Kbd>
              <ArrowUp />
            </Kbd>
            <Kbd>
              <ArrowDown />
            </Kbd>
            <span className="text-muted-foreground/80">Navigate</span>
          </KbdGroup>
          <KbdGroup>
            <Kbd>↩</Kbd>
            <span className="text-muted-foreground/80">Enter folder</span>
          </KbdGroup>
          {!atRoot && (
            <KbdGroup>
              <Kbd>
                <ArrowLeft />
              </Kbd>
              <span className="text-muted-foreground/80">Go up</span>
            </KbdGroup>
          )}
        </div>
      </div>
    </div>
  );
}

interface PickerRowProps {
  entry: FsEntry;
  added: boolean;
  ignored: boolean;
  index: number;
  highlighted: boolean;
  onNavigate: () => void;
  onHover: () => void;
  onPick: (mode: CarryOverEntry["mode"]) => void;
}

function PickerRow({
  entry,
  added,
  ignored,
  index,
  highlighted,
  onNavigate,
  onHover,
  onPick,
}: PickerRowProps) {
  const isFolder = entry.isDirectory;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard nav lives on the focused filter input above
    <li
      data-row-idx={index}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5",
        isFolder && "cursor-pointer",
        highlighted && "bg-accent text-accent-foreground",
        !isFolder && !ignored && !highlighted && "opacity-60",
      )}
      onClick={isFolder ? onNavigate : undefined}
      onMouseEnter={onHover}
    >
      <MaterialIcon
        kind={isFolder ? "folder" : "file"}
        name={entry.name}
        expanded={isFolder && highlighted}
        className="size-4"
      />
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={entry.name}
      >
        {entry.name}
        {isFolder ? "/" : ""}
      </span>
      {added ? (
        <span className="px-2 text-[11px] text-muted-foreground">Added</span>
      ) : ignored ? (
        <div
          className="inline-flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onPick("symlink")}
            title="Edits stay in sync with the main checkout"
          >
            <LinkIcon />
            Symlink
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onPick("copy")}
            title="Independent snapshot at worktree creation"
          >
            <CopyIcon />
            Copy
          </Button>
        </div>
      ) : (
        <span
          className="px-2 text-[11px] text-muted-foreground/70"
          title="Tracked by git. Only ignored files and folders can be carried over."
        >
          tracked
        </span>
      )}
    </li>
  );
}
