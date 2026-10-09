// The worktree's own options, one switch each, in a popover off the
// footer: the footer keeps one button for all of them however many
// there are. Below them, the page's rarer verbs (OptionActionView), which
// close it to open a dialog.
import { Archive, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { ToggleRowView } from "@/components/shared/ToggleRowView";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FooterVerbView, LABEL_RANK } from "./FooterVerbView";

type OptionSwitch = {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
};

export function WorktreeOptionsView({
  autoPull,
  shelve,
  children,
}: {
  // `can` is false for a branch with no upstream to pull from.
  autoPull: OptionSwitch & { can: boolean };
  // Only a managed worktree shelves.
  shelve?: OptionSwitch;
  // The page's rarer verbs (OptionActionView).
  children?: ReactNode;
}) {
  // Set when a row hands off to a dialog: focus then stays out of the
  // footer rather than return to Options behind the dialog, where a
  // keypress would reopen the popover over it.
  const handedOff = useRef(false);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) handedOff.current = false;
      }}
    >
      <FooterVerbView
        rank={LABEL_RANK.options}
        icon={<SlidersHorizontal />}
        label="Options"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
        render={<PopoverTrigger />}
      />
      <PopoverContent
        side="top"
        align="end"
        className="w-80"
        finalFocus={() => !handedOff.current}
      >
        <div className="flex flex-col gap-3 p-2">
          <ToggleRowView
            label={<OptionLabel icon={<RefreshCw />} name="Auto-pull" />}
            description={
              autoPull.can
                ? "Fast-forward from the upstream after each fetch, while there are no local commits, changes or running scripts."
                : "Needs a branch that tracks an upstream."
            }
            checked={autoPull.checked}
            disabled={autoPull.disabled}
            onCheckedChange={autoPull.onChange}
          />
          {shelve && (
            <ToggleRowView
              label={<OptionLabel icon={<Archive />} name="Shelved" />}
              description="Folded away under Shelved in the sidebar, out of the main list."
              checked={shelve.checked}
              disabled={shelve.disabled}
              onCheckedChange={shelve.onChange}
            />
          )}
          <div
            className="contents"
            onClickCapture={() => (handedOff.current = true)}
          >
            {children}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// An option's icon and name, as a row in the popover wears them.
function OptionLabel({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
      {icon}
      {name}
    </span>
  );
}

// A verb in the Options popover: its icon and name, as an option's
// row has them (OptionLabel), and what it does beneath. It closes the
// popover, so the dialog it opens stands alone.
export function OptionActionView({
  icon,
  label,
  description,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <PopoverClose
      onClick={onClick}
      className="-m-1 flex flex-col items-start rounded-md p-1 text-left hover:bg-muted dark:hover:bg-muted/50"
    >
      <span className="text-sm">
        <OptionLabel icon={icon} name={label} />
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </PopoverClose>
  );
}
