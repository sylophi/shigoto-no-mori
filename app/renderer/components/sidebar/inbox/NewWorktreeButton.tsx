import { useRef, useState, type ReactNode } from "react";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import type { RemoteForestItem } from "@shigomori/ui/lib/forest.ts";
import { useCommandableApi } from "@/hooks/remote/useCommandAccess";
import {
  useQuickCreateWorktree,
  wantsCreateForm,
} from "@/hooks/worktrees/useQuickCreateWorktree";
import { rankByScore } from "@shigomori/ui/lib/fuzzyMatch.ts";
import type { Project } from "@shigomori/contracts/schemas";
import type { ProjectGroupOrder } from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import { DeviceBadgeView } from "@shigomori/ui/views/sidebar/DeviceBadgeView.tsx";
import {
  useGroupCreator,
  useGroupMembers,
  useIconMember,
  type GroupMember,
  type LiveMember,
} from "../ProjectGroupActions";
import type { ProjectSection } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import type { ProjectListRow } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import { buildCreateSections } from "./createTargets";
import {
  CreateMenuListView,
  CreateMenuView,
  CreateTargetItemView,
  NewWorktreeButtonView,
} from "@shigomori/ui/views/sidebar/inbox/NewWorktreeButtonView.tsx";

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
        <NewWorktreeButtonView disabled />
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
      <NewWorktreeButtonView
        pending={isPending}
        disabled={isPending}
        aria-busy={isPending}
        onClick={(event) => createFrom(event, creator.project.id)}
      />
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
    <CreateMenuView
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
      inputRef={inputRef}
      list={
        <CreateMenuListView
          query={query}
          onQueryChange={setQuery}
          inputRef={inputRef}
          sections={shown}
          onModifier={noteModifier}
          renderRow={(target) => (
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
          )}
        />
      }
    />
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
    <CreateTargetItemView
      value={target.key}
      name={target.project.name}
      busy={busy}
      disabled={creating !== null}
      onSelect={onSelect}
      icon={
        <ProjectIcon
          projectId={icon?.project.id ?? target.project.id}
          name={target.project.name}
          deviceId={icon?.deviceId}
        />
      }
      badge={badge && <DeviceBadgeView badge={badge} />}
    />
  );
}
