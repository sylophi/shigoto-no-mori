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
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { MaterialIcon } from "@/components/ui/material-icon";
import { PathSpan } from "@/components/ui/path-span";
import { cn } from "@/lib/utils";
import { useFsListDirectory } from "@/hooks/useFsListDirectory";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";

interface FolderPickerModalProps {
  // Absolute path the picker opens at; falls back to ~/ when omitted.
  initialPath?: string;
  title?: string;
  confirmLabel?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

// In-app folder picker. Lets the user walk the filesystem and confirm a
// directory; returns the absolute path of the directory currently shown
// in the header. Used wherever a flow needs to capture a folder path
// without falling back to the native OS dialog.
export function FolderPickerModal({
  initialPath,
  title = "Pick a folder",
  confirmLabel = "Use this folder",
  onPick,
  onClose,
}: FolderPickerModalProps) {
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const [cwd, setCwd] = useState<string>(initialPath ?? home ?? "~/");
  const [filter, setFilter] = useState("");
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Once runtime info arrives, snap the cwd to the real home if the
  // caller didn't pass an initial path. Without this, the picker would
  // stay parked at the "~/" sentinel and never resolve.
  useEffect(() => {
    if (!initialPath && home && cwd === "~/") {
      setCwd(home);
    }
  }, [home, initialPath, cwd]);

  const { data: listing, isLoading, error } = useFsListDirectory(cwd);

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

  const atRoot = cwd === "/";

  const goUp = () => {
    if (atRoot) return;
    const idx = cwd.lastIndexOf("/");
    if (idx < 0) return;
    const parent = idx === 0 ? "/" : cwd.slice(0, idx);
    setCwd(parent);
    setFilter("");
  };

  const navigateInto = (name: string) => {
    setCwd(cwd === "/" ? `/${name}` : `${cwd}/${name}`);
    setFilter("");
  };

  const trimmed = filter.trim().toLowerCase();
  const entries = (listing?.entries ?? []).filter((e) =>
    trimmed ? e.name.toLowerCase().includes(trimmed) : true,
  );

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
      if (target) {
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

  const resolvedCwd = listing?.path ?? cwd;

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
          <PathSpan
            path={resolvedCwd}
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

        <div className="flex items-center justify-between gap-2 border-b border-border bg-card/40 px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={title}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- picker just opened
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <Button
            type="button"
            size="xs"
            onClick={() => onPick(resolvedCwd)}
            disabled={isLoading || !!error}
          >
            {confirmLabel}
          </Button>
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
              {trimmed ? `No folders matching "${trimmed}".` : "Empty folder."}
            </div>
          ) : (
            <ul ref={listRef} className="divide-y divide-border/40">
              {entries.map((entry, idx) => (
                // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard nav lives on the focused filter input above
                <li
                  key={entry.name}
                  data-row-idx={idx}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                    idx === highlightedIdx &&
                      "bg-accent text-accent-foreground",
                  )}
                  onClick={() => navigateInto(entry.name)}
                  onMouseEnter={() => setHighlightedIdx(idx)}
                >
                  <MaterialIcon
                    kind="folder"
                    name={entry.name}
                    expanded={idx === highlightedIdx}
                    className="size-4"
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={entry.name}
                  >
                    {entry.name}/
                  </span>
                </li>
              ))}
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
