import { FolderOpen } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { tildify } from "@shigomori/contracts/projectPaths";
import type { WorktreeLayout } from "@shigomori/contracts/schemas";
import type { DeviceLayout } from "@/hooks/config/useDeviceLayout";
import type { LayoutOption } from "./layoutOptions";
import {
  managedDriveBaseFor,
  worktreeBaseFor,
} from "@shared/git/worktreeLayout";

interface LayoutOptionItemProps {
  option: LayoutOption;
  checked: boolean;
  projectPath: string;
  device: DeviceLayout;
  customPath: string;
  customPathError: string | null;
  onSelect: (layout: WorktreeLayout) => void;
  onOpenPicker: () => void;
}

export function LayoutOptionItemView({
  option,
  checked,
  projectPath,
  device,
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
            ...device,
            layout: option.value,
            projectPath,
            customPath:
              option.value === "custom" ? customPath.trim() || null : null,
          }),
          device.homedir,
        )}/`;
  // The device's "Keep worktrees on the project's drive" setting takes
  // the managed layout out of the data folder for a project on an
  // external drive, and the description follows the preview there.
  const description =
    option.value === "managed-root" &&
    managedDriveBaseFor(projectPath, device) !== null
      ? "Worktrees live in Shigomori's folder on the project's drive."
      : option.description;
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
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
              recommended
            </span>
          )}
        </div>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {previewPath && (
          <SimpleTooltip whenTruncated tip={previewPath}>
            <p className="truncate font-mono text-xs text-foreground/70 select-text">
              {previewPath}
            </p>
          </SimpleTooltip>
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
