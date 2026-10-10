import type { ReactNode, RefObject } from "react";
import { Command } from "cmdk";
import { GitBranch } from "lucide-react";
import {
  ITEM_CLASS,
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "@/components/ui/cmdk-classes";
import { GithubMark } from "@/components/ui/svgs/github-mark";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ActionInputRowView,
  DestinationRowView,
  FormFooterView,
} from "./DialogPartsView";

// The clone tab: the URL as typed, the device's GitHub repositories
// under it to pick from, and the folder it clones into (CloneForm.tsx
// runs the clone).
export function CloneFormView({
  url,
  onUrl,
  inputRef,
  highlighted,
  onHighlight,
  rows,
  typedRow,
  repo,
  canClone,
  onClone,
  dest,
  onChangeParent,
  terrierOptIn,
  picker,
}: {
  url: string;
  onUrl: (url: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  highlighted: string;
  onHighlight: (value: string) => void;
  // The repositories to pick from, narrowed by what is typed.
  rows: readonly string[];
  // The first row is the `owner/repo` typed out, not one of the list.
  typedRow: boolean;
  // The repository as repo identity spells it.
  repo: string;
  // What is typed or picked names a repository.
  canClone: boolean;
  onClone: () => void;
  // Where it clones to.
  dest: string;
  onChangeParent: () => void;
  terrierOptIn: ReactNode;
  // The folder picker, while it is open.
  picker: ReactNode;
}) {
  return (
    <>
      {/* The Command holds the input and its list alone: around the
          rest, its keys would take ↩ from the buttons below. */}
      <Command
        label="Clone"
        loop
        shouldFilter={false}
        // Only a click or ↑↓ picks a row: a pointer passing over the
        // list on its way to the button would otherwise pick for it.
        disablePointerSelection
        // Ctrl+N/P move the caret in a text field on macOS.
        vimBindings={false}
        value={highlighted}
        onValueChange={onHighlight}
        className={MODAL_COMMAND_CLASS}
      >
        <ActionInputRowView
          value={url}
          onChange={onUrl}
          placeholder="Git URL or GitHub owner/repo"
          inputRef={inputRef}
          icon={<GitBranch className="size-3.5" />}
          label="Clone"
          canSubmit={canClone}
          onSubmit={onClone}
          combobox
        />
        {rows.length > 0 && (
          <Command.List
            onMouseDown={keepFocusInInput}
            className="max-h-64 overflow-y-auto border-b border-border p-2"
          >
            {rows.map((row, index) => (
              <Command.Item
                key={row}
                value={row}
                className={cn(ITEM_CLASS, "hover:bg-accent/50")}
              >
                {typedRow && index === 0 ? (
                  <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
                ) : (
                  <GithubMark className="size-4 shrink-0 text-muted-foreground/80" />
                )}
                <SimpleTooltip whenTruncated lazy tip={row}>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {row}
                  </span>
                </SimpleTooltip>
              </Command.Item>
            ))}
          </Command.List>
        )}
      </Command>
      <div className="flex flex-col gap-3 p-4 text-sm">
        {rows.length === 0 && canClone && (
          <div className="flex items-center gap-2.5">
            <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
            <SimpleTooltip whenTruncated tip={repo}>
              <span className="min-w-0 flex-1 truncate font-mono">{repo}</span>
            </SimpleTooltip>
          </div>
        )}
        <DestinationRowView dest={dest} onChangeParent={onChangeParent} />
      </div>
      <FormFooterView label="Clone">{terrierOptIn}</FormFooterView>
      {picker}
    </>
  );
}
