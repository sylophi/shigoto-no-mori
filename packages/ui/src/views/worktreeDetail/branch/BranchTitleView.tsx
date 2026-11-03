import { useRef, type ReactNode } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import { BranchLabel } from "../../../primitives/branch-label.tsx";
import { CopyButton } from "../../../primitives/copy-button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../primitives/dropdown-menu.tsx";
import { InlineEdit } from "../../../primitives/inline-edit.tsx";
import { InlineError } from "../../../primitives/inline-error.tsx";
import { sanitizeBranchName } from "@shigomori/contracts/git/branches";
import { IconButton } from "../../../primitives/icon-button.tsx";
import { cn } from "../../../lib/utils.ts";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";

// The branch's two sizes: the page's title, or a line under the work's
// own title.
const SIZES = {
  title: {
    heading: "h1",
    text: "text-2xl font-medium tracking-tight",
    suffix: "text-base tracking-normal",
  },
  subtitle: {
    heading: "p",
    text: "text-sm text-muted-foreground",
    suffix: undefined,
  },
} as const;

// The branch, renamed in place. The page's title, unless the work has
// a title of its own (useWorktreeTitle), and then a line under it.
// Rename, switch and copy sit beside it (BranchActionsView), and behind
// one button on a phone, so the name keeps the room. BranchTitle holds
// the edit and runs the rename.
export function BranchTitleView({
  branch,
  detached,
  rebasing,
  subtitle = false,
  editing,
  actions,
  titleRef,
}: {
  branch: string;
  detached: boolean;
  rebasing?: string | undefined;
  subtitle?: boolean;
  // The rename under way, in place of the name.
  editing?: {
    pending: boolean;
    error: string | undefined;
    onSave: (branch: string) => void;
    onCancel: () => void;
  };
  // The branch's buttons (BranchActionsView), beside the name.
  actions: ReactNode;
  // The name's element, which the switcher hangs from.
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  const size = SIZES[subtitle ? "subtitle" : "title"];
  const Heading = size.heading;

  if (editing) {
    return (
      <InlineEdit
        variant="icons"
        size={subtitle ? "subtitle" : "title"}
        value={branch}
        label="Branch name"
        pending={editing.pending}
        sanitize={sanitizeBranchName}
        onSave={editing.onSave}
        onCancel={editing.onCancel}
        error={
          editing.error !== undefined && (
            <InlineError
              message={editing.error}
              title="Couldn't rename the branch"
              className="text-xs text-destructive"
            />
          )
        }
        inputClassName="font-mono"
      />
    );
  }

  return (
    <div className="group/copy flex min-w-0 items-center gap-1.5">
      <SimpleTooltip
        whenTruncated
        tip={
          <BranchLabel
            branch={branch}
            detached={detached}
            rebasing={rebasing}
          />
        }
      >
        <Heading
          ref={titleRef}
          data-branch-name
          className={cn("min-w-0 truncate font-mono", size.text)}
        >
          <BranchLabel
            branch={branch}
            detached={detached}
            rebasing={rebasing}
            suffixClassName={size.suffix}
          />
        </Heading>
      </SimpleTooltip>
      {actions}
    </div>
  );
}

// The branch's buttons wait for the cursor, as its copy button does.
const HOVER_ONLY = "group-hover/copy:opacity-100";

// Rename, switch and copy beside the branch, and on a phone behind one
// button in their place. Rename and switch only where they're offered:
// only copy on a peer that takes no commands from here, and no rename
// for a detached head, which can still switch onto a branch.
export function BranchActionsView({
  branch,
  detached,
  onRename,
  onSwitch,
  onCopy,
  switcher,
}: {
  branch: string;
  detached: boolean;
  onRename: (() => void) | undefined;
  onSwitch: (() => void) | undefined;
  onCopy: () => void;
  // The switcher (BranchSwitcher) with its own button, hung from the
  // name. Mounted on a phone too, where the menu opens it.
  switcher: ReactNode;
}) {
  const copyLabel = detached ? "Copy commit hash" : "Copy branch name";
  // Set when an item hands focus on (the rename field, the switcher),
  // so the closing menu doesn't take it back to its button.
  const handedOff = useRef(false);
  const handOff = (action: () => void) => () => {
    handedOff.current = true;
    action();
  };
  return (
    <>
      <div className="contents phone:hidden">
        {onRename && (
          <IconButton
            onClick={onRename}
            aria-label="Rename branch"
            reveal
            className={HOVER_ONLY}
          >
            <Pencil className="size-3.5" />
          </IconButton>
        )}
        {switcher}
        <CopyButton value={branch} label={copyLabel} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              aria-label="Branch actions"
              className="hidden shrink-0 text-muted-foreground/50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground phone:block"
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
          {onRename && (
            <DropdownMenuItem onClick={handOff(onRename)}>
              Rename branch
            </DropdownMenuItem>
          )}
          {onSwitch && (
            <DropdownMenuItem onClick={handOff(onSwitch)}>
              Switch branch…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onCopy}>{copyLabel}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
