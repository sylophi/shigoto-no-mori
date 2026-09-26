// The pieces the folder browsers share: the Add Project dialog's
// browse stage (addProject/AddProjectView.tsx) and the folder picker
// (FolderPickerModal.tsx), whose input is the path, listed live, and
// for the key hints also the filter-first picker (PathPickerModal.tsx).
import type { ReactNode } from "react";
import { Command } from "cmdk";
import { ArrowDown, ArrowLeft, ArrowUp, CornerLeftUp } from "lucide-react";
import { ITEM_CLASS } from "@/components/ui/cmdk-classes";
import { KbdHint } from "@/components/ui/kbd";

// The `..` row at the top of a cmdk browse list, one folder up. Its
// value carries the lists' "browse:" row prefix.
export function BrowseUpItem({ onSelect }: { onSelect: () => void }) {
  return (
    <Command.Item
      value="browse:up"
      keywords={[".."]}
      onSelect={onSelect}
      className={ITEM_CLASS}
    >
      <CornerLeftUp className="size-4 text-muted-foreground/80" />
      <span className="font-mono text-muted-foreground">..</span>
    </Command.Item>
  );
}

// The footer's key hints: the arrows (or the caller's own lead), ↩
// into the highlighted folder, and ← up out of this one.
export function BrowseKeyHints({
  lead,
  enterFolder,
  goUp,
}: {
  lead?: ReactNode;
  enterFolder: boolean;
  goUp: boolean;
}) {
  return (
    <>
      {lead ?? (
        <KbdHint
          keys={[<ArrowUp key="up" />, <ArrowDown key="down" />]}
          label="Navigate"
        />
      )}
      {enterFolder && <KbdHint keys={["↩"]} label="Enter folder" />}
      {goUp && <KbdHint keys={[<ArrowLeft key="left" />]} label="Go up" />}
    </>
  );
}
