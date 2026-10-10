import type { ReactNode } from "react";
import { FolderInput, FolderOpen, RotateCcw } from "lucide-react";
import { BlockingOverlay } from "../../primitives/blocking-overlay.tsx";
import { Button } from "../../primitives/button.tsx";
import { PathSpan } from "../../primitives/path-span.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";

// Where the shigomori data dir lives, and the flow that moves it. The
// picker (the in-app FolderPickerModal, which still offers Finder on
// this machine) chooses the new PARENT and the folder lands under its
// canonical name (the main process owns that rule in
// lib/dataDirMove.ts). A folder away from the default location gets a
// Reset button, which is the same move with no parent given. On success
// the main process relaunches the app, so the overlay's job is just to
// block interaction until the window goes away.
//
// Host-scoped: mounted for a peer, the same flow moves THAT device's
// folder. The peer's app relaunches itself after answering (this
// window has no say in another machine's lifecycle), this window
// stays up, and the session that lands when the peer is back refetches
// its runtime info, so the new path shows up on its own.
export function DataLocationSectionView({
  remote,
  root,
  home,
  moving,
  busy,
  movable,
  atDefault,
  resetArmed,
  onReveal,
  onPickParent,
  onReset,
  picker,
}: {
  // A peer's folder: its app restarts, not this window.
  remote: boolean;
  // The data folder, null until the runtime info lands.
  root: string | null;
  home: string | null;
  moving: boolean;
  // Moving, or a peer restarting after one.
  busy: boolean;
  // The move is refused when this session's data dir came from
  // SHIGOMORI_DATA_DIR (a sandbox owns it), so it isn't offered.
  movable: boolean;
  atDefault: boolean;
  // Reset asked for once: the app restarts on the spot.
  resetArmed: boolean;
  onReveal: () => void;
  onPickParent: () => void;
  onReset: () => void;
  // The folder picker for the new parent, while it is open.
  picker: ReactNode;
}) {
  // Whose app the copy below is talking about.
  const there = remote ? " on that device" : "";
  return (
    <section className="space-y-3">
      {/* The overlay stands in for a window that is about to go away.
          A peer's move leaves this window up, so there it would only
          block work on every other device for as long as a copy across
          volumes takes. The disabled buttons say enough. */}
      {moving && !remote && (
        <BlockingOverlay>
          Moving data folder… The app will restart.
        </BlockingOverlay>
      )}
      <SectionHeading className="mb-1">Data location</SectionHeading>
      {root && (
        <div className="flex font-mono text-sm select-text">
          <PathSpan
            path={root}
            home={home}
            className="min-w-0 flex-1 truncate"
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Worktrees, configs, and state live here. Moving the folder restarts the
        app{there}, and the CLI follows automatically.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* This machine's Finder can only show this machine's disk. */}
        {!remote && (
          <Button
            variant="outline"
            size="sm"
            disabled={!root}
            onClick={onReveal}
          >
            <FolderOpen />
            Reveal in Finder
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!movable || busy}
          onClick={onPickParent}
        >
          <FolderInput />
          Move data folder…
        </Button>
        {movable && !atDefault && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-pressed={resetArmed}
            onClick={onReset}
          >
            <RotateCcw />
            {resetArmed ? "Reset and restart?" : "Reset to default"}
          </Button>
        )}
      </div>
      {remote && busy && (
        <p className="text-xs text-muted-foreground">
          {moving
            ? "Moving the data folder on that device…"
            : "Moved. The new location shows once that device is back."}
        </p>
      )}
      {picker}
    </section>
  );
}
