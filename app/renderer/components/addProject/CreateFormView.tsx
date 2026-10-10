import type { ReactNode, RefObject } from "react";
import { ChevronDown, FolderPlus } from "lucide-react";
import type { GhUnavailableReason } from "@shigomori/contracts/schemas";
import { Checkbox } from "@shigomori/ui/primitives/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { SegmentedControl } from "@shigomori/ui/primitives/segmented-control.tsx";
import { GithubMark } from "@shigomori/ui/primitives/svgs/github-mark.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { GH_UNAVAILABLE_TEXT } from "@/lib/pullRequest";
import {
  ActionInputRowView,
  DestinationRowView,
  FormFooterView,
} from "./DialogPartsView";

export type Visibility = "private" | "public";

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
] as const;

// The create tab: the new repository's name, its folder, and whether
// it goes up to GitHub, under whose name and how visible (CreateForm.tsx
// creates and publishes it).
export function CreateFormView({
  name,
  onName,
  inputRef,
  canCreate,
  onCreate,
  dest,
  onChangeParent,
  ghUnavailable,
  publish,
  onPublish,
  owners,
  owner,
  onOwner,
  visibility,
  onVisibility,
  terrierOptIn,
  picker,
}: {
  name: string;
  onName: (name: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  // The name makes a folder name.
  canCreate: boolean;
  onCreate: () => void;
  dest: string;
  onChangeParent: () => void;
  // Why the device's gh can't publish, "loading" while that isn't known
  // yet, or null when it can.
  ghUnavailable: GhUnavailableReason | "loading" | null;
  publish: boolean;
  onPublish: (publish: boolean) => void;
  // The accounts it can go under, undefined until listed.
  owners: readonly string[] | undefined;
  owner: string | undefined;
  onOwner: (owner: string) => void;
  visibility: Visibility;
  onVisibility: (visibility: Visibility) => void;
  terrierOptIn: ReactNode;
  // The folder picker, while it is open.
  picker: ReactNode;
}) {
  return (
    <>
      <ActionInputRowView
        value={name}
        onChange={onName}
        placeholder="Name of the new repository"
        inputRef={inputRef}
        icon={<FolderPlus className="size-3.5" />}
        label="Create"
        canSubmit={canCreate}
        onSubmit={onCreate}
      />
      <div className="flex flex-col gap-3 p-4 text-sm">
        <DestinationRowView dest={dest} onChangeParent={onChangeParent} />
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
          <SimpleTooltip
            tip={
              ghUnavailable && ghUnavailable !== "loading"
                ? GH_UNAVAILABLE_TEXT[ghUnavailable]
                : undefined
            }
          >
            <label className="-mx-1 flex shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-1 select-none has-disabled:cursor-not-allowed has-disabled:opacity-50">
              <Checkbox
                checked={publish}
                disabled={ghUnavailable !== null}
                onCheckedChange={(next) => {
                  onPublish(next);
                  inputRef.current?.focus();
                }}
              />
              <GithubMark className="size-4" />
              Publish to GitHub
            </label>
          </SimpleTooltip>
          {publish && (
            <div className="ml-auto flex items-center gap-2">
              {owners && owner && (
                <OwnerMenu owners={owners} owner={owner} onChange={onOwner} />
              )}
              <SegmentedControl
                value={visibility}
                onChange={onVisibility}
                options={VISIBILITY_OPTIONS}
                aria-label="Visibility"
              />
            </div>
          )}
        </div>
      </div>
      <FormFooterView label="Create">{terrierOptIn}</FormFooterView>
      {picker}
    </>
  );
}

function OwnerMenu({
  owners,
  owner,
  onChange,
}: {
  owners: readonly string[];
  owner: string;
  onChange: (owner: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Owner"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <span className="max-w-40 truncate">{owner}</span>
        <ChevronDown aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
        <DropdownMenuRadioGroup
          value={owner}
          onValueChange={(value) => onChange(value as string)}
        >
          {owners.map((entry) => (
            <DropdownMenuRadioItem key={entry} value={entry}>
              {entry}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
