import { useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EMPTY_CLASS,
  HEADING_CLASS,
  INPUT_CLASS,
  ITEM_CLASS,
  MODAL_COMMAND_CLASS,
} from "@/components/ui/cmdk-classes";
import { KbdHint } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import { useCommandableApi } from "@/hooks/remote/useCommandAccess";
import {
  useQuickCreateWorktree,
  wantsCreateForm,
} from "@/hooks/worktrees/useQuickCreateWorktree";
import { rankByScore } from "@/lib/fuzzyMatch";
import { cn } from "@/lib/utils";
import type { Project } from "@shigomori/contracts/schemas";
import type { ProjectGroupOrder } from "../buildSidebarRows";
import { DeviceBadge } from "../DeviceBadge";
import {
  useGroupCreator,
  useGroupMembers,
  useIconMember,
  type GroupMember,
  type LiveMember,
} from "../ProjectGroupActions";
import type { ProjectListRow, ProjectSection } from "../projectListSections";
import { buildCreateSections } from "./createTargets";

interface NewWorktreeButtonProps {
  projects: readonly Project[];
  // Peers' forests, so a project that lives only on another machine
  // (or on this one and others) can be created into from here.
  remote: RemoteForestItem[];
  order: ProjectGroupOrder;
  byOwner: boolean;
}

// The inbox view's create affordance. Classic view hangs a + off each
// project header. The inbox has none, so the project has to be picked
// here: one project means there's nothing to pick and the button
// creates outright, several open a searchable list of them, a repo on
// several devices listed once like the tree's header. A pick lands
// where that header's + would (useGroupCreator), and the form a
// modified pick opens can move it to another device.
export function NewWorktreeButton({
  projects,
  remote,
  order,
  byOwner,
}: NewWorktreeButtonProps) {
  const commandableApi = useCommandableApi();
  const sections = buildCreateSections({
    projects,
    remote,
    order,
    byOwner,
    commandableApi,
  });
  const targets = sections.flatMap((section) => section.rows);

  // Nothing to pick between: create outright, or sit disabled with no
  // menu behind it when there's nowhere to create at all.
  const [only] = targets;
  if (only === undefined) {
    return (
      <SimpleTooltip tip="Nowhere to create a worktree yet">
        <Button variant="outline" size="sm" disabled className="w-full">
          <Plus aria-hidden />
          New worktree
        </Button>
      </SimpleTooltip>
    );
  }
  if (targets.length === 1) {
    return (
      <CreatorScope target={only}>
        {(creator) => <SingleCreateButton target={only} creator={creator} />}
      </CreatorScope>
    );
  }
  return <CreateMenu sections={sections} targets={targets} />;
}

// The project's checkouts as the header's actions see them, the one a
// create lands on (useGroupCreator), and whose icon the project wears
// (useIconMember). What's inside runs under the creator's scope, so
// the create hook there lands on its device.
function CreatorScope({
  target,
  children,
}: {
  target: ProjectListRow;
  children: (creator: LiveMember, icon: GroupMember | undefined) => ReactNode;
}) {
  const members = useGroupMembers(
    target.members,
    target.local ? target.project : undefined,
  );
  const creator = useGroupCreator(members, target.project.identity);
  const icon = useIconMember(members, target.local);
  if (creator === undefined) return null;
  return (
    <MaybeHostScope deviceId={creator.deviceId} api={creator.api}>
      {children(creator, icon)}
    </MaybeHostScope>
  );
}

function SingleCreateButton({
  target,
  creator,
}: {
  target: ProjectListRow;
  creator: LiveMember;
}) {
  const { createFrom, isPending } = useQuickCreateWorktree();
  const where = creator.isThisDevice
    ? target.project.name
    : `${target.project.name} on ${creator.deviceLabel}`;
  return (
    <SimpleTooltip tip={`New worktree in ${where} (hold ⇧ to pick a base)`}>
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        aria-busy={isPending}
        onClick={(event) => createFrom(event, creator.project.id)}
        className="w-full"
      >
        {isPending ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : (
          <Plus aria-hidden />
        )}
        {isPending ? "Creating worktree…" : "New worktree"}
      </Button>
    </SimpleTooltip>
  );
}

function CreateMenu({
  sections,
  targets,
}: {
  sections: readonly ProjectSection[];
  targets: readonly ProjectListRow[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The row whose create is under way. Every row waits for it, so a
  // second pick can't start another before its page is up. The ref
  // holds the lock, since keys pressed before the next render all see
  // the state as it was.
  const [creating, setCreating] = useState<string | null>(null);
  const lockedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether the ↩ or click that picks a row held a modifier, which
  // opens the form rather than creating outright. cmdk's onSelect
  // carries no event, so the root notes it on the way down.
  const modifiedRef = useRef(false);
  const noteModifier = (event: React.KeyboardEvent | React.MouseEvent) => {
    if ("key" in event && event.key !== "Enter") return;
    modifiedRef.current = wantsCreateForm(event);
  };
  const pick = (
    key: string,
    create: () => Promise<boolean>,
    form: () => void,
  ) => {
    if (lockedRef.current) return;
    const modified = modifiedRef.current;
    modifiedRef.current = false;
    if (modified) {
      form();
      setOpen(false);
      return;
    }
    // Open until the new worktree's page is up, so the wait shows on
    // the row picked.
    lockedRef.current = true;
    setCreating(key);
    void create().then((created) => {
      lockedRef.current = false;
      setCreating(null);
      if (created) setOpen(false);
    });
  };
  // A search is one list, best match first: kept under the owners, a
  // weaker match in an earlier owner would take the highlight.
  const search = query.trim();
  const shown: readonly ProjectSection[] = search
    ? [
        {
          key: "search",
          label: null,
          rows: [
            ...rankByScore(search, targets, (target) => target.project.name),
          ],
        },
      ]
    : sections;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="w-full">
            <Plus aria-hidden />
            New worktree
          </Button>
        }
      />
      <PopoverContent
        // The search, for typing straight away, but not under a finger,
        // where focusing it would bring up the keyboard over the list.
        initialFocus={(openType) =>
          openType === "touch" ? false : inputRef.current
        }
        sideOffset={6}
        className="flex w-(--anchor-width) flex-col overflow-hidden p-0"
      >
        <Command
          label="New worktree in"
          loop
          shouldFilter={false}
          onKeyDownCapture={noteModifier}
          onClickCapture={noteModifier}
          className={MODAL_COMMAND_CLASS}
        >
          <div
            data-slot="search-row"
            className="flex items-center gap-2 border-b border-border px-3 py-1.5"
          >
            <Search
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="New worktree in…"
              className={INPUT_CLASS}
            />
          </div>
          <Command.List className="max-h-80 min-h-0 overflow-y-auto p-1">
            {shown.map((section) => (
              <Command.Group
                key={section.key}
                heading={
                  section.label === null ? undefined : (
                    <div className={cn(HEADING_CLASS, "truncate")}>
                      {section.label}
                    </div>
                  )
                }
              >
                {section.rows.map((target) => (
                  <CreatorScope key={target.key} target={target}>
                    {(creator, icon) => (
                      <TargetItem
                        target={target}
                        creator={creator}
                        icon={icon}
                        creating={creating}
                        onPick={pick}
                      />
                    )}
                  </CreatorScope>
                ))}
              </Command.Group>
            ))}
            <Command.Empty className={EMPTY_CLASS}>
              No projects match.
            </Command.Empty>
          </Command.List>
          <div
            data-slot="footer-row"
            className="flex items-center border-t border-border px-3 py-2 text-2xs text-muted-foreground phone:hidden"
          >
            {/* ↩ creating goes without saying. ⇧ is for a click too. */}
            <KbdHint keys={["⇧"]} label="Pick a base" />
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TargetItem({
  target,
  creator,
  icon,
  creating,
  onPick,
}: {
  target: ProjectListRow;
  creator: LiveMember;
  icon: GroupMember | undefined;
  creating: string | null;
  onPick: (
    key: string,
    create: () => Promise<boolean>,
    form: () => void,
  ) => void;
}) {
  // Bound to the creator's scope (CreatorScope), so the create and the
  // form land on its device.
  const { quickCreate, openCreateForm } = useQuickCreateWorktree();
  const { project } = creator;
  const busy = creating === target.key;
  // Where it lands, when that's a peer: this machine's goes unsaid, as
  // on every row.
  const badge = creator.isThisDevice
    ? undefined
    : target.devices.find((device) => device.deviceId === creator.deviceId);
  const onSelect = () =>
    onPick(
      target.key,
      () => quickCreate(project.id),
      () => openCreateForm(project.id),
    );
  return (
    <Command.Item
      value={target.key}
      onSelect={onSelect}
      disabled={creating !== null}
      className={ITEM_CLASS}
    >
      {busy ? (
        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
      ) : (
        <ProjectIcon
          projectId={icon?.project.id ?? target.project.id}
          name={target.project.name}
          deviceId={icon?.deviceId}
        />
      )}
      <SimpleTooltip whenTruncated tip={target.project.name}>
        <span className="min-w-0 flex-1 truncate">{target.project.name}</span>
      </SimpleTooltip>
      {badge && <DeviceBadge badge={badge} />}
    </Command.Item>
  );
}
