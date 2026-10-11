import { useId } from "react";
import { Switch } from "../../primitives/switch.tsx";
import { cn } from "../../lib/utils.ts";
import { usersAlone, type UsersAloneReason } from "../../lib/usersAlone.ts";

interface ToggleRowProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  switchClassName?: string;
  // Menu-sized type, for a row in a popover.
  dense?: boolean;
  // Why the app's guide leaves the switch, and the label that flips it,
  // to the user (lib/usersAlone.ts).
  alone?: UsersAloneReason;
}

export function ToggleRowView({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  switchClassName,
  dense = false,
  alone,
}: ToggleRowProps) {
  // The switch is a span with a role, which the label around it doesn't
  // name: it takes its name and description from the row's text.
  const labelId = useId();
  const descriptionId = useId();
  return (
    // The hover fill bleeds past the row on a negative margin, which
    // would beat the gap a space-y parent gives the row. A flow-root box
    // contains it, so the fill overhangs without moving the neighbors.
    <div
      className="flow-root"
      {...(alone === undefined ? {} : usersAlone(alone))}
    >
      <label
        className={cn(
          "-m-1 flex items-start gap-3 rounded-md p-1",
          // The row has no fill of its own, so the hover fill ghost
          // buttons wear gives doubutsu's stripes something to sit on.
          disabled
            ? "cursor-not-allowed"
            : "cursor-pointer hover:bg-muted dark:hover:bg-muted/50",
        )}
      >
        <span className={cn("mt-0.5", disabled && "opacity-50")}>
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            className={switchClassName}
            aria-labelledby={labelId}
            aria-describedby={description ? descriptionId : undefined}
          />
        </span>
        <div className="flex min-w-0 flex-col">
          <span
            id={labelId}
            className={cn(
              dense ? "text-xs" : "text-sm",
              disabled && "opacity-50",
            )}
          >
            {label}
          </span>
          {description && (
            <span
              id={descriptionId}
              className={cn(
                dense ? "text-2xs leading-snug" : "text-xs",
                "text-muted-foreground",
              )}
            >
              {description}
            </span>
          )}
        </div>
      </label>
    </div>
  );
}
