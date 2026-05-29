import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CornerLeftUp,
  Folder,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ModalShell } from "@/components/ui/modal-shell";
import { useFsListEntries } from "@/hooks/fs/useFsListEntries";
import { useIgnoredPaths } from "@/hooks/projects/useIgnoredPaths";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { PathSpan } from "@/components/ui/path-span";
import type { CarryOverEntry, FsEntry } from "@shared/schemas";
import { PickerRow } from "./PickerRow";

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
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- cwd diverges from projectPath as the user navigates; CarryOverSection remounts via key={projectPath} to reseed
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

  const resetView = (nextCwd: string) => {
    setCwd(nextCwd);
    setFilter("");
    setHighlightedIdx(0);
  };

  const goUp = () => {
    if (atRoot) return;
    const idx = cwd.lastIndexOf("/");
    if (idx <= 0) return;
    const parent = cwd.slice(0, idx);
    if (parent.length < projectPath.length) return;
    resetView(parent);
  };

  const navigateInto = (name: string) => {
    resetView(`${cwd}/${name}`);
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

  return (
    <ModalShell onClose={onClose} popoverClassName="flex flex-col">
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
        <PathSpan
          path={cwd}
          home={home}
          className="min-w-0 flex-1 truncate font-mono text-sm select-text"
        />
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
          onChange={(e) => {
            setFilter(e.target.value);
            setHighlightedIdx(0);
          }}
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
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            Couldn't read folder.
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
    </ModalShell>
  );
}
