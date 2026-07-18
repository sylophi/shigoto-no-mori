import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { router } from "@/router";
import { Input } from "@/components/ui/input";
import { ModalShell } from "@/components/ui/modal-shell";
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

// Launchpad-style project switcher in a modal: search on top, a grid of
// project tiles below. Activating a tile jumps to the project's
// most-recently-used worktree (see lib/recentWorktrees.ts).
export function ProjectLauncher() {
  const { launcherOpen, setLauncherOpen, toggleLauncher } = useOverlays();

  // The shortcut is wired via a native menu accelerator in main/menu.ts
  // — View → Project launcher (⌘⇧P).
  useEffect(
    () => window.api.projectLauncher.onToggle(toggleLauncher),
    [toggleLauncher],
  );

  if (!launcherOpen) return null;

  return <LauncherModal onClose={() => setLauncherOpen(false)} />;
}

function LauncherModal({ onClose }: { onClose: () => void }) {
  const { data: projects = [] } = useProjects();
  const { data: sortMode = "manual" } = useProjectSort();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

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

  // Restore focus to wherever the user was before the launcher opened.
  useEffect(() => {
    const previous = document.activeElement;
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

  // Escape is handled here (not by ModalShell) so it can clear the query
  // first and only close on a second press. Keydown bubbles up from the
  // input, so this works no matter where focus ended up.
  const onContentKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (query) {
      setQuery("");
      setSelectedIndex(0);
    } else {
      onClose();
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      closeOnEscape={false}
      popoverClassName="max-w-2xl"
    >
      <div role="presentation" onKeyDown={onContentKeyDown}>
        <div className="border-b border-border p-3">
          {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- Input renders a native <input>, which is focusable */}
          <Input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the search field is the whole point of a launcher
            autoFocus
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
            className="w-full px-3 py-2 text-sm"
          />
        </div>
        {/* The pattern surface: doubutsu hangs the leaf wallpaper on this
            slot (a non-scrolling wrapper, so the pattern holds still while
            the grid scrolls inside it). */}
        <div data-slot="launcher" className="relative isolate overflow-hidden">
          <div className="max-h-[60vh] overflow-y-auto p-3">
            {projects.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No projects yet — press {shortcutLabel(modKey, "N")} to add one.
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No projects match.
              </p>
            ) : (
              <div
                id="launcher-grid"
                ref={gridRef}
                role="listbox"
                aria-label="Projects"
                className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2"
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
    </ModalShell>
  );
}
