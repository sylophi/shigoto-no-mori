import { useRef, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { BranchLabel } from "@shigomori/ui/primitives/branch-label.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { InlineError } from "@shigomori/ui/primitives/inline-error.tsx";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { sanitizeBranchName } from "@shigomori/contracts/git/branches";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

// The branch's two sizes: the page's title, or a line under the work's
// own title. The rename field is as tall as the line it stands in for,
// and pulled back by its padding and border so the name stays put:
// starting a rename doesn't move the page.
const SIZES = {
  title: {
    heading: "h1",
    text: "text-2xl font-medium tracking-tight",
    suffix: "text-base tracking-normal",
    input: "-ml-2.25 h-8 px-2 text-2xl font-medium tracking-tight",
    button: "p-1.5",
    icon: "size-4",
  },
  subtitle: {
    heading: "p",
    text: "text-sm text-muted-foreground",
    suffix: undefined,
    input: "-ml-1.75 h-5.5 px-1.5 text-sm",
    button: "p-1",
    icon: "size-3.5",
  },
} as const;

// The branch, renamed in place. The page's title, unless the work has
// a title of its own (useWorktreeTitle), and then a line under it.
// Rename, switch and copy sit behind one button (BranchMenuView), so
// the line keeps its room for what's beside it (WorktreeHeaderView).
// BranchTitle holds the edit and runs the rename.
export function BranchTitleView({
  branch,
  detached,
  subtitle = false,
  editing,
  menu,
  titleRef,
}: {
  branch: string;
  detached: boolean;
  subtitle?: boolean;
  // The rename under way, in place of the name.
  editing?: {
    draft: string;
    onDraftChange: (draft: string) => void;
    pending: boolean;
    error: string | undefined;
    onCommit: () => void;
    onCancel: () => void;
  };
  // The branch's menu (BranchMenu), beside the name.
  menu: ReactNode;
  // The name's element, which the switcher hangs from.
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  const size = SIZES[subtitle ? "subtitle" : "title"];
  const Heading = size.heading;

  if (editing) {
    const { draft, pending, onCommit: commit, onCancel: cancel } = editing;
    return (
      // Grows to the room it's given, where a row has more beside it.
      <div className="flex min-w-0 grow flex-wrap items-center gap-2">
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
          autoFocus
          value={draft}
          disabled={pending}
          onChange={(e) =>
            editing.onDraftChange(sanitizeBranchName(e.target.value))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className={cn("min-w-0 flex-1 py-0 font-mono", size.input)}
        />
        <IconButton
          onClick={commit}
          disabled={pending}
          aria-label="Confirm rename"
          className={size.button}
        >
          <Check className={size.icon} />
        </IconButton>
        <IconButton
          onClick={cancel}
          disabled={pending}
          aria-label="Cancel rename"
          className={size.button}
        >
          <X className={size.icon} />
        </IconButton>
        {editing.error !== undefined && (
          <InlineError
            message={editing.error}
            title="Couldn't rename the branch"
            className="basis-full text-xs text-destructive"
          />
        )}
      </div>
    );
  }

  return (
    <div className="group/branch flex min-w-0 items-center gap-1.5">
      <SimpleTooltip
        whenTruncated
        tip={<BranchLabel branch={branch} detached={detached} />}
      >
        <Heading
          ref={titleRef}
          data-branch-name
          className={cn("min-w-0 truncate font-mono", size.text)}
        >
          <BranchLabel
            branch={branch}
            detached={detached}
            suffixClassName={size.suffix}
          />
        </Heading>
      </SimpleTooltip>
      {menu}
    </div>
  );
}

// Rename, switch and copy behind one button. Only copy on a peer that
// takes no commands from here.
export function BranchMenuView({
  canCommand,
  detached,
  onRename,
  onSwitch,
  onCopy,
  switcher,
}: {
  canCommand: boolean;
  detached: boolean;
  onRename: () => void;
  onSwitch: () => void;
  onCopy: () => void;
  // The switcher (BranchSwitcher), hung from the name.
  switcher: ReactNode;
}) {
  // Set when an item hands focus on (the rename field, the switcher),
  // so the closing menu doesn't take it back to its button.
  const handedOff = useRef(false);
  const handOff = (action: () => void) => () => {
    handedOff.current = true;
    action();
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              aria-label="Branch actions"
              className="shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/branch:opacity-100 focus-visible:opacity-100 data-[popup-open]:bg-accent data-[popup-open]:text-foreground data-[popup-open]:opacity-100 phone:opacity-100"
            >
              <ChevronDown aria-hidden className="size-3.5" />
            </IconButton>
          }
        />
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          finalFocus={() => {
            const keep = handedOff.current;
            handedOff.current = false;
            return !keep;
          }}
        >
          {/* A detached head has no branch to rename, but can switch
              onto one. */}
          {canCommand && !detached && (
            <DropdownMenuItem onClick={handOff(onRename)}>
              Rename branch
            </DropdownMenuItem>
          )}
          {canCommand && (
            <DropdownMenuItem onClick={handOff(onSwitch)}>
              Switch branch…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onCopy}>
            {detached ? "Copy commit hash" : "Copy branch name"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {switcher}
    </>
  );
}
