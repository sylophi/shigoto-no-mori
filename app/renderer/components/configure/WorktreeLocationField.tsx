import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { LAYOUT_OPTIONS } from "@/components/worktreeLocation/layoutOptions";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import type { ShigomoriConfig } from "@shared/schemas";

// Which layout the project's worktrees use, as the saved config has it.
// The pick itself lives on a subpage: changing it can move worktrees,
// and the subpage lists each one with where it goes.
export function WorktreeLocationField({
  projectId,
  config,
  home,
}: {
  projectId: string;
  config: ShigomoriConfig | null;
  home: string | null;
}) {
  const { toProjectPage } = useProjectNav();
  const layout = config?.worktreeLayout ?? "managed-root";
  const option = LAYOUT_OPTIONS.find((o) => o.value === layout);
  // A custom layout has no description; its folder says more.
  const customPath =
    layout === "custom" ? config?.customWorktreePath?.trim() : undefined;

  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">Location</span>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm">{option?.label}</span>
          {customPath ? (
            <PathSpan
              path={customPath}
              home={home}
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            />
          ) : (
            option?.description && (
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            )
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toProjectPage("worktreeLocation", projectId)}
        >
          Change…
        </Button>
      </div>
    </div>
  );
}
