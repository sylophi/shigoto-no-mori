import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import type { WorktreeLayout } from "@shared/schemas";
import { worktreeBaseFor } from "@shared/worktreeLayout";

export interface LayoutOption {
  value: WorktreeLayout;
  label: string;
  description?: string;
  recommended?: boolean;
}

interface LayoutOptionItemProps {
  option: LayoutOption;
  checked: boolean;
  projectPath: string;
  dataDir: string;
  home: string;
  customPath: string;
  customPathError: string | null;
  onSelect: (layout: WorktreeLayout) => void;
  onOpenPicker: () => void;
}

export function LayoutOptionItem({
  option,
  checked,
  projectPath,
  dataDir,
  home,
  customPath,
  customPathError,
  onSelect,
  onOpenPicker,
}: LayoutOptionItemProps) {
  const hasCustomPath = customPath.trim().length > 0;
  // Skip the preview line entirely for an empty custom layout.
  // The picker button below carries the next action instead, so
  // a "/your/custom/path/<name>" stub would just be noise.
  const previewPath =
    option.value === "custom" && !hasCustomPath
      ? null
      : `${tildify(
          worktreeBaseFor({
            layout: option.value,
            projectPath,
            dataDir,
            customPath:
              option.value === "custom" ? customPath.trim() || null : null,
          }),
          home,
        )}/`;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 text-sm transition-colors",
        checked
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-accent/30",
      )}
    >
      <input
        type="radio"
        name="worktree-layout"
        value={option.value}
        checked={checked}
        onChange={() => onSelect(option.value)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{option.label}</span>
          {option.recommended && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              recommended
            </span>
          )}
        </div>
        {option.description && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {option.description}
          </p>
        )}
        {previewPath && (
          <p
            className="truncate font-mono text-xs text-foreground/70 select-text"
            title={previewPath}
          >
            {previewPath}
          </p>
        )}
        {option.value === "custom" && (
          <div className="space-y-1 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!checked}
              onClick={(event) => {
                // The wrapping label would otherwise re-fire the
                // click and toggle the radio off/on around the picker.
                event.preventDefault();
                onOpenPicker();
              }}
            >
              <FolderOpen />
              {hasCustomPath ? "Change folder" : "Choose folder…"}
            </Button>
            {customPathError && (
              <p className="text-xs text-destructive">{customPathError}</p>
            )}
          </div>
        )}
      </div>
    </label>
  );
}
