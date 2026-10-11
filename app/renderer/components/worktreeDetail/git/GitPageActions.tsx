import { useState } from "react";
import { ChevronDown, GitMerge, ListRestart } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import type { Worktree } from "@shared/schemas";
import { HardResetDialog } from "./HardResetDialog";
import { MergeDialog } from "./MergeDialog";

// The Git page's moves on the whole branch, in a menu at the end of its
// sidebar's back row: another branch brought in, or the branch moved
// anywhere. None on a peer that takes no commands from here.
export function GitPageActions({ worktree }: { worktree: Worktree }) {
  const [open, setOpen] = useState<"merge" | "hardReset" | null>(null);
  const { canCommand } = useCommandAccess();
  if (!canCommand) return null;
  const close = () => setOpen(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="xs">
              Branch
              <ChevronDown />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuItem onClick={() => setOpen("merge")}>
            <GitMerge />
            Merge…
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setOpen("hardReset")}
          >
            <ListRestart />
            Hard reset…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "merge" && <MergeDialog worktree={worktree} onClose={close} />}
      {open === "hardReset" && (
        <HardResetDialog worktree={worktree} onClose={close} />
      )}
    </>
  );
}
