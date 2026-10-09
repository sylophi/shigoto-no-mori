import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  Copy,
  FileDiff,
  Folder,
  GitPullRequest,
  Play,
  Plus,
  SquarePen,
} from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { LauncherIconView } from "@/components/shared/LauncherIconView";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { openPullRequest } from "@/components/worktreeDetail/pullRequests/pullRequestShared";
import { useLaunch } from "@/hooks/launchers/useLaunchers";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { useSortedPackageScripts } from "@/hooks/scripts/usePackageScriptSort";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useSyncMoveMutations } from "@/hooks/worktrees/useWorktreeSync";
import { rankByScore } from "@/lib/fuzzyMatch";
import { worktreeSyncView } from "@/lib/syncState";
import { cn } from "@/lib/utils";
import { slotToParam, type ScriptSlot } from "@/store/scriptSlot";
import type { LauncherEntry } from "@shigomori/contracts/schemas";
import { PaletteGroup, PaletteItem, usePaneHasKeys } from "./PaletteItem";
import type { PaletteRow } from "./PaletteRows";
import type {
  PaletteEntry,
  PalettePage,
  PaletteProject,
} from "./buildPaletteEntries";

export type GoTo = (
  entry: PaletteEntry,
  page: "detail" | "diff" | "script",
  extra?: { scriptKey?: string },
) => void;

// What a verb can do, the palette's to give: each closes it on the way.
export interface PaletteActions {
  go: GoTo;
  close: () => void;
  // A worktree off the project's default branch, on `branch` when the
  // query named one. The palette stays up until it lands.
  create: (projectId: string, branch?: string) => void;
  // The new-worktree form, on the peer `deviceId` names, else here.
  openCreateForm: (projectId: string, deviceId?: string) => void;
  openPage: (page: PalettePage) => void;
}

// The highlighted row's verbs: a preview beside the list, where a click
// runs one and the keys they carry work from the list, until ⇥ hands
// the pane the keys and the query filters it. The first verb is the
// row's ↩. `launchers` are the highlighted worktree's tools, when it
// has any here: the palette holds their ⌘1..⌘9. Until `settled`, the
// verbs that load something (its scripts, its git move) wait.
export function PaletteVerbs({
  row,
  query,
  actions,
  launchers,
  settled,
}: {
  row: PaletteRow;
  query: string;
  actions: PaletteActions;
  launchers: readonly LauncherEntry[] | undefined;
  settled: boolean;
}) {
  switch (row.kind) {
    case "worktree":
      return (
        <WorktreeVerbs
          entry={row.entry}
          query={query}
          actions={actions}
          launchers={launchers}
          settled={settled}
        />
      );
    case "project":
      return <ProjectVerbs item={row.item} query={query} actions={actions} />;
    case "page":
      return <PageVerbs page={row.page} query={query} actions={actions} />;
    case "create":
      return <CreateVerbs row={row} query={query} actions={actions} />;
  }
}

interface Verb {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  // The key that runs it wherever the keys are (a tool's ⌘ digit).
  keys?: string;
  // The key that runs it from the list (↩, ⌘↩), not shown once the
  // pane has the keys and ↩ runs whichever verb is highlighted.
  listKeys?: string;
  // What the query matches, when not the label.
  search?: string;
  disabled?: boolean;
  tip?: string;
}

const ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground/80";
const iconOf = (Icon: ComponentType<SVGProps<SVGSVGElement>>) => (
  <Icon className={ICON_CLASS} />
);

// A group of verbs, filtered by the query the way the worktree list
// is, each group on its own so the groups keep their places.
function VerbGroup({
  heading,
  query,
  verbs,
}: {
  heading: string;
  query: string;
  verbs: readonly Verb[];
}) {
  const hasKeys = usePaneHasKeys();
  const shown = rankByScore(query, verbs, (verb) => verb.search ?? verb.label);
  if (shown.length === 0) return null;
  return (
    <PaletteGroup heading={heading}>
      {shown.map((verb) => {
        const keys = verb.keys ?? (hasKeys ? undefined : verb.listKeys);
        return (
          <PaletteItem
            key={verb.key}
            value={verb.key}
            onSelect={verb.run}
            disabled={verb.disabled}
            tip={verb.tip}
            className="text-xs"
          >
            {verb.icon}
            <span className="min-w-0 flex-1 truncate">{verb.label}</span>
            {keys && <Kbd className="ml-auto shrink-0">{keys}</Kbd>}
          </PaletteItem>
        );
      })}
    </PaletteGroup>
  );
}

// Its pages first, then its tools, its git move and its scripts. The
// scripts and the git move run on the machine it lives on, so they
// mount in that device's scope: a peer asleep has no session to run
// anything over, and offers the rest alone.
function WorktreeVerbs({
  entry,
  query,
  actions,
  launchers,
  settled,
}: {
  entry: PaletteEntry;
  query: string;
  actions: PaletteActions;
  launchers: readonly LauncherEntry[] | undefined;
  settled: boolean;
}) {
  const { worktree, pr } = entry;
  const deviceId = entry.device?.deviceId;
  const api = useRemoteDeviceApi(deviceId);
  const reachable = deviceId === undefined || api !== undefined;
  const opens: Verb[] = [
    {
      key: "detail",
      label: "Open worktree",
      icon: iconOf(Folder),
      listKeys: "↩",
      run: () => actions.go(entry, "detail"),
    },
    {
      key: "diff",
      label: "Open changes",
      icon: iconOf(FileDiff),
      listKeys: "⌘↩",
      run: () => actions.go(entry, "diff"),
    },
  ];
  if (pr) {
    opens.push({
      key: "pr",
      label: `Open pull request #${pr.number}`,
      icon: iconOf(GitPullRequest),
      tip: pr.title,
      run: () => {
        actions.close();
        openPullRequest(pr.url);
      },
    });
  }
  return (
    <>
      <VerbGroup heading="Go to" query={query} verbs={opens} />
      {launchers && (
        <LauncherVerbs
          entry={entry}
          query={query}
          actions={actions}
          launchers={launchers}
        />
      )}
      {settled && reachable && (
        <MaybeHostScope deviceId={deviceId ?? ""} api={api}>
          <SyncVerbs entry={entry} query={query} actions={actions} />
          <ScriptVerbs entry={entry} query={query} actions={actions} />
        </MaybeHostScope>
      )}
      <VerbGroup
        heading="More"
        query={query}
        verbs={[
          {
            key: "copy-path",
            label: "Copy path",
            icon: iconOf(Copy),
            tip: worktree.path,
            run: () => {
              void navigator.clipboard.writeText(worktree.path);
              actions.close();
            },
          },
        ]}
      />
    </>
  );
}

// Its tools, ⌘1..⌘9 in the order drawn.
function LauncherVerbs({
  entry,
  query,
  actions,
  launchers,
}: {
  entry: PaletteEntry;
  query: string;
  actions: PaletteActions;
  launchers: readonly LauncherEntry[];
}) {
  const { mutate: launch } = useLaunch();
  return (
    <VerbGroup
      heading="Launch"
      query={query}
      verbs={launchers.map((launcher, i) => ({
        key: `launch:${launcher.id}`,
        label: launcher.label,
        search: `Open in ${launcher.label}`,
        icon: <LauncherIconView entry={launcher} />,
        keys: i < 9 ? `⌘${i + 1}` : undefined,
        run: () => {
          launch({
            projectId: entry.worktree.projectId,
            worktreeId: entry.worktree.id,
            launcherId: launcher.id,
          });
          actions.close();
        },
      }))}
    />
  );
}

function SyncVerbs({
  entry,
  query,
  actions,
}: {
  entry: PaletteEntry;
  query: string;
  actions: PaletteActions;
}) {
  const { worktree } = entry;
  const mutations = useSyncMoveMutations();
  const { canCommand } = useCommandAccess();
  // The pill's safe move, when it can run now (lib/syncState).
  const { move } = worktreeSyncView(worktree);
  if (!move || move.disabledReason) return null;
  return (
    <VerbGroup
      heading="Git"
      query={query}
      verbs={[
        {
          key: move.key,
          label: move.label,
          icon: iconOf(move.Icon),
          disabled: !canCommand,
          tip: canCommand ? undefined : peerReadOnlyNote(),
          run: () => {
            mutations[move.key].mutate({
              projectId: worktree.projectId,
              worktreeId: worktree.id,
            });
            actions.close();
          },
        },
      ]}
    />
  );
}

function ScriptVerbs({
  entry,
  query,
  actions,
}: {
  entry: PaletteEntry;
  query: string;
  actions: PaletteActions;
}) {
  const { worktree } = entry;
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);
  const { sorted } = useSortedPackageScripts(worktree.projectId, pkg);
  const scripts = rankByScore(query, sorted, (script) => script.name);
  if (scripts.length === 0) return null;
  return (
    <PaletteGroup heading="Scripts">
      {scripts.map((script) => (
        <ScriptVerb
          key={script.name}
          entry={entry}
          name={script.name}
          command={script.command}
          actions={actions}
        />
      ))}
    </PaletteGroup>
  );
}

// Runs the script and lands on its console, so the output is what you
// see next. One already running just opens the console. Its own row,
// not a Verb: each script asks its runner whether it is busy.
function ScriptVerb({
  entry,
  name,
  command,
  actions,
}: {
  entry: PaletteEntry;
  name: string;
  command: string;
  actions: PaletteActions;
}) {
  const slot: ScriptSlot = { kind: "package", name };
  const { busy, canRun, disabledReason, start } = useScriptRunner(
    entry.worktree,
    slot,
  );
  return (
    <PaletteItem
      className="text-xs"
      value={`script:${name}`}
      disabled={!busy && !canRun}
      onSelect={() => {
        if (!busy) start();
        actions.go(entry, "script", { scriptKey: slotToParam(slot) });
      }}
      tip={disabledReason ?? command}
    >
      <Play className={ICON_CLASS} />
      <span className="shrink-0 font-mono">{name}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-right font-mono text-2xs text-muted-foreground",
          busy && "text-emerald-500",
        )}
      >
        {busy ? "running" : command}
      </span>
    </PaletteItem>
  );
}

function ProjectVerbs({
  item,
  query,
  actions,
}: {
  item: PaletteProject;
  query: string;
  actions: PaletteActions;
}) {
  const { project, device, lead, localProject } = item;
  const verbs: Verb[] = [];
  if (lead) {
    verbs.push({
      key: "go",
      label: `Open ${lead.worktree.branch}`,
      icon: iconOf(Folder),
      listKeys: "↩",
      run: () => actions.go(lead, "detail"),
    });
  }
  if (localProject) {
    verbs.push({
      key: "create",
      label: "New worktree",
      icon: iconOf(Plus),
      run: () => actions.create(localProject.id),
    });
  }
  // With no worktree to open, ↩ opens the form, on the device that
  // holds the project.
  verbs.push({
    key: "form",
    label: "New worktree from…",
    icon: iconOf(SquarePen),
    listKeys: lead ? undefined : "↩",
    run: () => actions.openCreateForm(project.id, device?.deviceId),
  });
  return <VerbGroup heading={project.name} query={query} verbs={verbs} />;
}

function PageVerbs({
  page,
  query,
  actions,
}: {
  page: PalettePage;
  query: string;
  actions: PaletteActions;
}) {
  return (
    <VerbGroup
      heading={page.label}
      query={query}
      verbs={[
        {
          key: "open",
          label: `Open ${page.label}`,
          icon: iconOf(page.icon),
          listKeys: "↩",
          run: () => actions.openPage(page),
        },
      ]}
    />
  );
}

// Which project the new worktree goes into: the likeliest is ↩, the
// rest a ⇥ away, and the form for a base or a device of its own.
function CreateVerbs({
  row,
  query,
  actions,
}: {
  row: Extract<PaletteRow, { kind: "create" }>;
  query: string;
  actions: PaletteActions;
}) {
  const [first] = row.targets;
  return (
    <VerbGroup
      heading={`New worktree ${row.branch}`}
      query={query}
      verbs={[
        ...row.targets.map(
          (project): Verb => ({
            key: `create:${project.id}`,
            label: `In ${project.name}`,
            icon: <ProjectIcon projectId={project.id} name={project.name} />,
            listKeys: project === first ? "↩" : undefined,
            run: () => actions.create(project.id, row.branch),
          }),
        ),
        {
          key: "create-form",
          label: "Pick a base or device…",
          icon: iconOf(SquarePen),
          run: () => actions.openCreateForm(first.id),
        },
      ]}
    />
  );
}
