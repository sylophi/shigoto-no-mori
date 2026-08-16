import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { GROUP_CLASS } from "@/components/ui/cmdk";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ModalShell } from "@/components/ui/modal-shell";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { router } from "@/router";
import { PaletteRow } from "./PaletteRow";
import { parsePaletteContext } from "./paletteModel";
import { usePaletteSections } from "./usePaletteSections";

// Global command palette. Fuzzy-searches every worktree across every
// project (the headline job: switching between 3-10 parallel ones),
// plus projects and the actions that matter from wherever the user is.
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, togglePalette } = useOverlays();

  // ⌘K is a native accelerator (View → Command palette in
  // main/electron/menu.ts), so it fires wherever focus sits — including
  // inside a text field, which is what you want from ⌘K — and the
  // renderer needs no window-level listener. The one thing the menu
  // can't know is whether another ModalShell is already up: those don't
  // trap focus, so the palette would mount underneath and steal their
  // keyboard. Same guard the project launcher uses. Closing is never
  // guarded, or ⌘K couldn't dismiss the palette it just opened.
  useEffect(
    () =>
      window.api.commandPalette.onToggle(() => {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (document.querySelector('[data-slot="modal-shell"]')) return;
        togglePalette();
      }),
    [paletteOpen, setPaletteOpen, togglePalette],
  );

  if (!paletteOpen) return null;
  return <PaletteOverlay onClose={() => setPaletteOpen(false)} />;
}

function PaletteOverlay({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Snapshot of where the user was when the palette opened. This
  // component renders as a sibling of RouterProvider (App.tsx), so
  // there's no router context to subscribe to — and a snapshot is the
  // right semantics anyway: the contextual actions shouldn't shift
  // under the user while the palette is up. The lazy initializer reads
  // it once per open.
  const [context] = useState(() =>
    parsePaletteContext(router.state.location.pathname),
  );

  const { sections, isLoading, hasProjects } = usePaletteSections(
    query.trim(),
    context,
    onClose,
  );

  const items = sections.flatMap((section) => section.items);
  // Derive the highlight rather than trusting the stored one: narrowing
  // the query can delete the selected row out from under us, and a
  // controlled cmdk value pointing at a missing item leaves nothing
  // selected — ↩ would silently do nothing. Falling back to the first
  // row keeps type-then-Enter working on every keystroke.
  const selected = items.some((item) => item.value === highlighted)
    ? highlighted
    : (items[0]?.value ?? "");

  // Focus the field on open, hand focus back on close. Captured in an
  // effect rather than via an autoFocus attribute: React applies those
  // during commit, before effects run, so document.activeElement would
  // already be this input.
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <ModalShell onClose={onClose} popoverClassName="max-w-2xl">
      <Command
        label="Command palette"
        loop
        // Ranking is ours (lib/fuzzyMatch scores branch, directory and
        // project name separately and takes the best), so cmdk is left
        // as the keyboard/selection engine only — house pattern.
        shouldFilter={false}
        value={selected}
        onValueChange={setHighlighted}
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder="Search worktrees, projects and actions…"
            className="min-w-0 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <Command.List className="max-h-[22rem] overflow-y-auto p-2">
          {isLoading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : !hasProjects ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No projects yet — press ⌘N to add one.
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {`No matches for "${query.trim()}".`}
            </div>
          ) : (
            sections.map((section) => (
              <Command.Group
                key={section.id}
                heading={section.heading}
                className={GROUP_CLASS}
              >
                {section.items.map((item) => (
                  <PaletteRow key={item.value} item={item} />
                ))}
              </Command.Group>
            ))
          )}
        </Command.List>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
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
              <span className="text-muted-foreground/80">Open</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>esc</Kbd>
              <span className="text-muted-foreground/80">Close</span>
            </KbdGroup>
          </div>
          <span className="text-muted-foreground/80">⌘K</span>
        </div>
      </Command>
    </ModalShell>
  );
}
