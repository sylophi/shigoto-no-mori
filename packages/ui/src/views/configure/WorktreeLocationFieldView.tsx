import { Button } from "../../primitives/button.tsx";
import { PathSpan } from "../../primitives/path-span.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

// Which layout the project's worktrees use, as the saved config has it.
// The pick itself lives on a subpage: changing it can move worktrees,
// and the subpage lists each one with where it goes.
export function WorktreeLocationFieldView({
  label,
  description,
  shownPath,
  home,
  blocked,
  onChange,
}: {
  // The layout's name, and what it means.
  label: string | undefined;
  description: string | undefined;
  // A custom layout's folder, or the one the managed layout keeps on
  // the project's drive: they say more than a description.
  shownPath: string | null | undefined;
  home: string | null;
  // The form around it has unsaved edits, which leaving for the
  // subpage would throw away.
  blocked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">Location</span>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm">{label}</span>
          {shownPath ? (
            <PathSpan
              path={shownPath}
              home={home}
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            />
          ) : (
            description && (
              <span className="text-xs text-muted-foreground">
                {description}
              </span>
            )
          )}
        </div>
        <SimpleTooltip
          tip={blocked ? "Save or discard your changes first" : undefined}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={blocked}
            onClick={onChange}
          >
            Change…
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}
