import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SectionIntro } from "@shigomori/ui/primitives/section-heading.tsx";
import { Switch } from "@shigomori/ui/primitives/switch.tsx";
import { ExternalLink } from "@shigomori/ui/primitives/external-link.tsx";
import { normalizeRelPath } from "@shared/git/gitPaths";
import type {
  CarryOverEntry,
  CarryOverStat,
} from "@shigomori/contracts/schemas";
import { CarryOverRowView } from "./CarryOverRowView";

export function CarryOverSectionView({
  entries,
  includePaths,
  stats,
  isCovered,
  includeFileExists,
  noMatches,
  useWorktreeInclude,
  onToggleUseWorktreeInclude,
  onChangeMode,
  onRemove,
  onPickPath,
  picker,
}: {
  entries: readonly CarryOverEntry[];
  // .worktreeinclude matches, read-only rows in the same list as the
  // manual entries.
  includePaths: readonly string[];
  // Each path's size and kind, as far as measured.
  stats: Readonly<Record<string, CarryOverStat>> | undefined;
  // .worktreeinclude already copies the path into every new worktree.
  isCovered: (relative: string) => boolean;
  // The repo has a .worktreeinclude, matching none of the ignored
  // files.
  includeFileExists: boolean;
  noMatches: boolean;
  useWorktreeInclude: boolean;
  onToggleUseWorktreeInclude: (enabled: boolean) => void;
  onChangeMode: (path: string, mode: CarryOverEntry["mode"]) => void;
  onRemove: (path: string) => void;
  // Opens the picker, drawn in `picker` while it is up.
  onPickPath: () => void;
  picker: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <SectionIntro title="Carry over">
        Files and folders to copy or symlink into every new worktree, taken from
        the main checkout or, failing that, another worktree that has them
        (symlinks only ever point at the main checkout). Useful for things git
        ignores, like <span className="font-mono">.env</span>,{" "}
        <span className="font-mono">node_modules</span>, or editor state.
      </SectionIntro>

      {(includeFileExists || !useWorktreeInclude) && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Use <span className="font-mono">.worktreeinclude</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {useWorktreeInclude && noMatches
                ? "No gitignored files match its patterns."
                : "Copies matching gitignored files into every new worktree."}{" "}
              <ExternalLink
                href="https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees"
                errorTitle="Couldn't open docs"
              />
            </p>
          </div>
          <Switch
            checked={useWorktreeInclude}
            onCheckedChange={onToggleUseWorktreeInclude}
            aria-label="Use .worktreeinclude"
          />
        </div>
      )}

      {(entries.length > 0 || includePaths.length > 0) && (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <CarryOverRowView
              key={entry.path}
              entry={entry}
              stat={stats?.[entry.path]}
              covered={isCovered(normalizeRelPath(entry.path))}
              onChangeMode={(mode) => onChangeMode(entry.path, mode)}
              onRemove={() => onRemove(entry.path)}
            />
          ))}
          {includePaths.map((path) => (
            <CarryOverRowView
              key={`worktreeinclude:${path}`}
              entry={{ path, mode: "copy" }}
              stat={stats?.[path]}
              origin="worktreeinclude"
            />
          ))}
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={onPickPath}>
        <Plus />
        Add file or folder
      </Button>

      {picker}
    </section>
  );
}
