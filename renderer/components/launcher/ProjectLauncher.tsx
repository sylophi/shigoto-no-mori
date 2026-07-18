import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { router } from "@/router";
import { Input } from "@/components/ui/input";
import { sortProjects } from "@/components/sidebar/sortProjects";
import { useProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { rankByScore } from "@/lib/fuzzyMatch";
import { modKey, shortcutLabel } from "@/lib/platform";
import { getRecentWorktree } from "@/lib/recentWorktrees";
import type { Project, Worktree } from "@shared/schemas";
import { LauncherTile } from "./LauncherTile";

// Launchpad-style full-screen project switcher: search on top, a grid of
// project tiles below. Activating a tile jumps to the project's
// most-recently-used worktree (see lib/recentWorktrees.ts).
export function ProjectLauncher() {
  const { launcherOpen, setLauncherOpen, toggleLauncher } = useOverlays();

  // The menu shortcut is wired via a native accelerator in
  // main/electron/menu.ts — View → Project launcher (⌘⇧P).
  useEffect(
    () => window.api.projectLauncher.onToggle(toggleLauncher),
    [toggleLauncher],
  );

  // The backtick key (physical Backquote position — e.code keeps it
  // stable across keyboard layouts, matching DevThemeHotkeys) also
  // opens the launcher, unless the user is typing in a text field.
  // Unlike Tab it has no focus-navigation job, so it may fire even
  // while a button or link is focused. While the launcher is open it
  // closes it again via onRootKeyDown below, which preventDefaults
  // first — the defaultPrevented check here keeps that close from
  // bouncing straight back open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Backquote" || e.repeat || e.defaultPrevented) return;
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setLauncherOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLauncherOpen]);

  if (!launcherOpen) return null;

  return <LauncherOverlay onClose={() => setLauncherOpen(false)} />;
}

function LauncherOverlay({ onClose }: { onClose: () => void }) {
  const { data: projects = [] } = useProjects();
  const { data: sortMode = "manual" } = useProjectSort();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lazy fan-out: this component only mounts while the launcher is open,
  // and the queries share cache keys with the sidebar so they're warm.
  const worktreeQueries = useAllProjectWorktrees(projects, true);

  // Base order follows the user's sidebar sort; a query re-ranks by match.
  const ordered = sortProjects(projects, sortMode);
  const filtered = rankByScore(query.trim(), ordered, (p) => p.name);

  const clampedIndex =
    filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : -1;
  const selected = clampedIndex >= 0 ? filtered[clampedIndex] : undefined;
  const selectedId = selected?.id;

  // Focus the search field on open, and restore focus on close. The
  // capture must happen before the input is focused, which rules out an
  // autoFocus attribute: React applies those during commit, before any
  // effect runs, so document.activeElement would already be the
  // launcher's own input.
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    document
      .getElementById(`launcher-tile-${selectedId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // ProjectLauncher is rendered as a sibling of RouterProvider in App.tsx, so
  // `useNavigate` here has no router context and silently no-ops. Use the
  // module-level router instance directly instead.
  const navigate = router.navigate.bind(router);

  const activate = (project: Project) => {
    onClose();
    const queryIndex = projects.findIndex((p) => p.id === project.id);
    const trees = (worktreeQueries[queryIndex]?.data ?? []) as Worktree[];
    const recentId = getRecentWorktree(project.id);
    const target =
      trees.find((t) => t.id === recentId && !t.shelved) ??
      trees.find((t) => !t.shelved) ??
      trees[0];
    if (target) {
      void navigate({
        to: "/projects/$projectId/worktrees/$worktreeId",
        params: { projectId: project.id, worktreeId: target.id },
      });
    } else {
      // No worktrees (or the path is gone and the query never ran) — the
      // new-worktree page is the only useful destination.
      void navigate({
        to: "/projects/$projectId/new",
        params: { projectId: project.id },
      });
    }
  };

  // Columns are computed from the live grid so arrow-up/down stay correct
  // across window resizes (the grid is auto-fill).
  const columnCount = () => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(" ").length || 1;
  };

  // Roving selection: DOM focus stays in the input (Launchpad-style), the
  // grid highlight moves via aria-activedescendant.
  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const max = filtered.length - 1;
    const move = (delta: number) => {
      e.preventDefault();
      if (max < 0) return;
      setSelectedIndex(Math.max(0, Math.min(max, clampedIndex + delta)));
    };
    switch (e.key) {
      case "ArrowLeft":
        move(-1);
        break;
      case "ArrowRight":
        move(1);
        break;
      case "ArrowUp":
        move(-columnCount());
        break;
      case "ArrowDown":
        move(columnCount());
        break;
      case "Enter":
        e.preventDefault();
        if (selected) activate(selected);
        break;
      default:
        break;
    }
  };

  // Escape and backtick live on the overlay root so they work no
  // matter where focus ended up (keydown bubbles up from the input).
  // Escape clears the query first and closes on a second press;
  // backtick closes immediately so the key toggles Launchpad-style.
  // That means a literal ` can't be typed into the query — an
  // acceptable trade for the toggle feel, since project names don't
  // contain backticks.
  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      e.code === "Backquote" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (query) {
      setQuery("");
      setSelectedIndex(0);
    } else {
      onClose();
    }
  };

  const closeOnSelfClick = (e: ReactMouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // The root carries data-slot="launcher": doubutsu paints it opaque and
  // hangs the grass-triangle wallpaper on its ::before. It must not
  // scroll (the pattern would ride along), so scrolling lives in the
  // absolute inner layer; overflow-hidden clips the pattern's drift
  // bleed, matching the main canvas.
  return (
    <div
      role="presentation"
      data-slot="launcher"
      onKeyDown={onRootKeyDown}
      className="fixed inset-0 isolate z-50 animate-in overflow-hidden bg-background/80 backdrop-blur-md duration-150 fade-in-0"
    >
      <div
        role="presentation"
        onMouseDown={closeOnSelfClick}
        className="absolute inset-0 flex flex-col items-center overflow-y-auto"
      >
        <div
          role="presentation"
          onMouseDown={closeOnSelfClick}
          className="w-full max-w-3xl px-8 pt-[12vh] pb-16"
        >
          {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- Input renders a native <input>, which is focusable */}
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="launcher-grid"
            aria-activedescendant={
              selectedId ? `launcher-tile-${selectedId}` : undefined
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search projects…"
            // Launchpad proportions: a compact centered field above the
            // grid, not a full-width bar.
            className="mx-auto block w-full max-w-sm px-4 py-2 text-center text-sm"
          />
          {projects.length === 0 ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">
              No projects yet — press {shortcutLabel(modKey, "N")} to add one.
            </p>
          ) : filtered.length === 0 ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">
              No projects match.
            </p>
          ) : (
            <div
              id="launcher-grid"
              ref={gridRef}
              role="listbox"
              aria-label="Projects"
              className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3"
            >
              {filtered.map((project, i) => (
                <LauncherTile
                  key={project.id}
                  project={project}
                  selected={i === clampedIndex}
                  onActivate={activate}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
