import { useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineError } from "@/components/ui/inline-error";
import { Input } from "@/components/ui/input";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useRenameBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { sanitizeBranchName } from "@shared/git/branches";
import type { Worktree } from "@shared/schemas";
import { BranchSwitcher } from "./BranchSwitcher";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";

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
// Rename, switch and copy sit behind one button, so the line keeps its
// room for what's beside it (WorktreeHeader).
export function BranchTitle({
  worktree,
  subtitle = false,
}: {
  worktree: Worktree;
  subtitle?: boolean;
}) {
  // null while idle; the in-flight edit value otherwise. Folds "editing"
  // and "draft" together so we don't seed state from a prop.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const rename = useRenameBranch();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const size = SIZES[subtitle ? "subtitle" : "title"];
  const Heading = size.heading;

  const begin = () => {
    // Detached HEAD has no branch to rename, so guard against any caller
    // (incl. future keybindings) that bypasses the menu, which hides it.
    if (worktree.detached) return;
    rename.reset();
    setDraft(worktree.branch);
  };
  const cancel = () => {
    setDraft(null);
    rename.reset();
  };
  const commit = () => {
    const next = (draft ?? "").trim();
    if (!next || next === worktree.branch) {
      cancel();
      return;
    }
    rename.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        newBranch: next,
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  if (editing) {
    return (
      // Grows to the room it's given, where a row has more beside it.
      <div className="flex min-w-0 grow flex-wrap items-center gap-2">
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
          autoFocus
          value={draft ?? ""}
          disabled={rename.isPending}
          onChange={(e) => setDraft(sanitizeBranchName(e.target.value))}
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
          disabled={rename.isPending}
          aria-label="Confirm rename"
          className={size.button}
        >
          <Check className={size.icon} />
        </IconButton>
        <IconButton
          onClick={cancel}
          disabled={rename.isPending}
          aria-label="Cancel rename"
          className={size.button}
        >
          <X className={size.icon} />
        </IconButton>
        {rename.error && (
          <InlineError
            message={rename.error.message}
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
        tip={
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        }
      >
        <Heading
          ref={titleRef}
          data-branch-name
          className={cn("min-w-0 truncate font-mono", size.text)}
        >
          <BranchLabel
            branch={worktree.branch}
            detached={worktree.detached}
            suffixClassName={size.suffix}
          />
        </Heading>
      </SimpleTooltip>
      <BranchMenu worktree={worktree} anchorRef={titleRef} onRename={begin} />
    </div>
  );
}

// Rename, switch and copy behind one button. Only copy on a peer that
// takes no commands from here.
function BranchMenu({
  worktree,
  anchorRef,
  onRename,
}: {
  worktree: Worktree;
  anchorRef: React.RefObject<HTMLElement | null>;
  onRename: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  const { canCommand } = useCommandAccess();
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
          {canCommand && !worktree.detached && (
            <DropdownMenuItem onClick={handOff(onRename)}>
              Rename branch
            </DropdownMenuItem>
          )}
          {canCommand && (
            <DropdownMenuItem onClick={handOff(() => setSwitching(true))}>
              Switch branch…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => void navigator.clipboard.writeText(worktree.branch)}
          >
            {worktree.detached ? "Copy commit hash" : "Copy branch name"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BranchSwitcher
        worktree={worktree}
        anchorRef={anchorRef}
        open={switching}
        onOpenChange={setSwitching}
      />
    </>
  );
}
