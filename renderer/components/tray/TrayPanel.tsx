import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Plus } from "lucide-react";
import { sortProjects } from "@/components/sidebar/sortProjects";
import { ProjectIcon } from "@/components/sidebar/ProjectIcon";
import { ChipButton } from "@/components/ui/chip-button";
import { Input } from "@/components/ui/input";
import { useLauncherForProject } from "@/hooks/launchers/useLaunchers";
import { useProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { rankByScore } from "@/lib/fuzzyMatch";
import type { Project, Worktree } from "@shared/schemas";
import { TrayWorktreeRow, trayRowId } from "./TrayWorktreeRow";
import { byRelevance } from "./trayStatus";

interface TrayGroup {
  project: Project;
  worktrees: readonly Worktree[];
}

// Raise the main window and put it on this worktree. Main owns both
// halves (see main/electron/tray) so the window is already forward by
// the time the renderer navigates.
function reveal(worktree: Worktree): void {
  void window.api.tray.revealWorktree(worktree.projectId, worktree.id);
}

// The menu bar popover: every worktree, one line each, grouped by
// project. It reads the same queries as the sidebar (same cache keys,
// same invalidation broadcasts) -- the difference is what it leaves out.
export function TrayPanel() {
  const { data: projects = [] } = useProjects();
  const { data: sortMode = "manual" } = useProjectSort();
  const worktreeQueries = useAllProjectWorktrees(projects);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mainVisible, setMainVisible] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // useAllProjectWorktrees fans out over `projects` in its own order,
  // while the display order comes from the user's sidebar sort.
  const worktreesByProject = new Map<string, Worktree[]>();
  projects.forEach((project, i) => {
    worktreesByProject.set(project.id, worktreeQueries[i]?.data ?? []);
  });

  // Project order follows the sidebar sort: the popover is a second view
  // of the same forest, not a second opinion about it. Ordering *within*
  // a project is by urgency, which is what a glance surface is for.
  const groups: TrayGroup[] = sortProjects(projects, sortMode)
    .map((project) => {
      const trees = (worktreesByProject.get(project.id) ?? []).filter(
        (worktree) => !worktree.shelved,
      );
      return {
        project,
        worktrees: query
          ? rankByScore(query, trees, (worktree) => worktree.name)
          : trees.toSorted(byRelevance),
      };
    })
    .filter((group) => group.worktrees.length > 0);

  // Selection is held by id, not index, so a background refetch that
  // reorders the list doesn't move the highlight out from under the
  // user. An id that no longer exists falls back to the first row.
  const flat = groups.flatMap((group) => [...group.worktrees]);
  const active = flat.find((worktree) => worktree.id === selectedId) ?? flat[0];

  const { data: launchers } = useLauncherForProject(active?.projectId ?? null);
  const launcher = launchers?.entries[0] ?? null;

  // The popover is content-sized: measure the card and let main size the
  // window to it, so a two-worktree forest doesn't get a half-empty panel.
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const report = () => {
      void window.api.tray.resize(
        Math.max(1, Math.ceil(element.getBoundingClientRect().height)),
      );
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Each opening should feel like a fresh mount even though the window
  // is only hidden between them. Data freshness is already covered:
  // showing the window fires a real focus event, and every query in this
  // app refetches on focus.
  useEffect(
    () =>
      window.api.tray.onShown(() => {
        setQuery("");
        setSelectedId(null);
        inputRef.current?.focus();
        void window.api.tray.mainWindowVisible().then(setMainVisible);
      }),
    [],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!active) return;
    document
      .getElementById(trayRowId(active.id))
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const index = active ? flat.indexOf(active) : -1;
    const next = Math.max(0, Math.min(flat.length - 1, index + delta));
    setSelectedId(flat[next]?.id ?? null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter":
        e.preventDefault();
        if (active) reveal(active);
        break;
      case "Escape":
        e.preventDefault();
        // Clear the filter first, dismiss on a second press -- same
        // two-step Escape as the project launcher.
        if (query) {
          setQuery("");
        } else {
          void window.api.tray.close();
        }
        break;
      default:
        break;
    }
  };

  return (
    <div ref={panelRef} className="p-1.5">
      <div
        data-slot="tray-panel"
        className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <div className="p-1.5">
          {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- Input renders a native <input>, which is focusable */}
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="tray-list"
            aria-activedescendant={active ? trayRowId(active.id) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Filter worktrees…"
            className="h-7 w-full px-2 text-xs"
          />
        </div>

        {groups.length === 0 ? (
          <p className="px-3 pt-1 pb-3 text-center text-xs text-muted-foreground">
            {projects.length === 0
              ? "No projects yet."
              : query
                ? "No worktrees match."
                : "No worktrees yet."}
          </p>
        ) : (
          <div
            id="tray-list"
            role="listbox"
            aria-label="Worktrees"
            className="max-h-[380px] overflow-y-auto px-1.5 pb-1.5"
          >
            {groups.map((group) => (
              <div
                key={group.project.id}
                role="group"
                aria-label={group.project.name}
              >
                <ProjectHeading project={group.project} />
                {group.worktrees.map((worktree) => (
                  <TrayWorktreeRow
                    key={worktree.id}
                    worktree={worktree}
                    selected={worktree.id === active?.id}
                    launcher={worktree.id === active?.id ? launcher : null}
                    onSelect={() => setSelectedId(worktree.id)}
                    onActivate={() => reveal(worktree)}
                    onLaunch={(launcherId) => {
                      void window.api.launchers
                        .launch({
                          projectId: worktree.projectId,
                          worktreeId: worktree.id,
                          launcherId,
                        })
                        .finally(() => window.api.tray.close());
                    }}
                    onReveal={() => {
                      void window.api.shell.showItemInFolder(worktree.path);
                      void window.api.tray.close();
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <footer className="flex h-9 shrink-0 items-center justify-between border-t border-border px-1.5">
          <ChipButton
            onClick={() => {
              void window.api.tray.toggleMainWindow().then(setMainVisible);
            }}
          >
            {mainVisible ? "Hide window" : "Show window"}
          </ChipButton>
          <span className="pr-1 text-[10px] text-muted-foreground">
            ↩ to open
          </span>
        </footer>
      </div>
    </div>
  );
}

function ProjectHeading({ project }: { project: Project }) {
  return (
    <div className="flex h-6 items-center gap-1.5 px-2 pt-1">
      <ProjectIcon projectId={project.id} className="size-3" />
      <span className="min-w-0 flex-1 truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {project.name}
      </span>
      <button
        type="button"
        tabIndex={-1}
        title={`New worktree in ${project.name}`}
        aria-label={`New worktree in ${project.name}`}
        onClick={() => {
          void window.api.tray.revealNewWorktree(project.id);
        }}
        className="flex size-4 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        <Plus className="size-3" />
      </button>
    </div>
  );
}
