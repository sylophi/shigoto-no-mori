import { FolderOpen } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { tildify } from "@shigomori/contracts/projectPaths";
import type { LayoutOption } from "./layoutOptions.ts";
import {
  type DeviceLayout,
  managedDriveBase,
  worktreeBase,
} from "@shigomori/contracts/git/worktreeLayout";
import { OptionCard } from "../../primitives/option-card.tsx";
import { RowTag } from "../../primitives/row-tag.tsx";

interface LayoutOptionItemProps {
  option: LayoutOption;
  checked: boolean;
  projectPath: string;
  device: DeviceLayout;
  customPath: string;
  onOpenPicker: () => void;
}

export function LayoutOptionItemView({
  option,
  checked,
  projectPath,
  device,
  customPath,
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
          worktreeBase({
            ...device,
            layout: option.value,
            projectPath,
            customPath,
          }),
          device.homedir,
        )}/`;
  // The device's "Keep worktrees on the project's drive" setting takes
  // the managed layout out of the data folder for a project on an
  // external drive, and the description follows the preview there.
  const description =
    option.value === "managed-root" &&
    managedDriveBase(projectPath, device) !== undefined
      ? "Worktrees live in Shigoto no Mori's folder on the project's drive."
      : option.description;
  return (
    <>
      <OptionCard
        value={option.value}
        title={
          <>
            {option.label}
            {option.recommended && <RowTag>Recommended</RowTag>}
          </>
        }
        detail={
          (description || previewPath) && (
            <span className="flex flex-col gap-1">
              {description && (
                <span className="leading-relaxed">{description}</span>
              )}
              {previewPath && (
                <SimpleTooltip whenTruncated tip={previewPath}>
                  <span className="truncate font-mono">{previewPath}</span>
                </SimpleTooltip>
              )}
            </span>
          )
        }
      />
      {/* Under the card, not in it: the card is a button. */}
      {option.value === "custom" && checked && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={onOpenPicker}
        >
          <FolderOpen />
          {hasCustomPath ? "Change folder" : "Choose folder…"}
        </Button>
      )}
    </>
  );
}
