// The ⌘K palette over the fixtures: shigoto-no-mori's worktrees found by
// "port", a project and a page it names and the worktree it could make,
// with the highlighted row's verbs beside them, and the verbs holding
// the keys once ⇥ picks the row.
import type { ReactNode } from "react";
import { Copy, FileDiff, Folder, GitPullRequest, Settings } from "lucide-react";
import type { PaletteProject } from "@shigomori/ui/views/palette/paletteEntries.ts";
import type { PalettePage } from "@shigomori/ui/views/palette/paletteEntries.ts";
import type { PaletteEntry } from "@shigomori/ui/views/palette/paletteEntries.ts";
import {
  PaletteGroupView,
  PaletteItemView,
} from "@shigomori/ui/views/palette/PaletteItemView.tsx";
import type { PaletteRow } from "@shigomori/ui/views/palette/paletteEntries.ts";
import {
  CreateRowView,
  PageRowView,
  ProjectRowView,
  WorktreeRowView,
} from "@shigomori/ui/views/palette/PaletteRowsView.tsx";
import {
  iconOf,
  ScriptVerbView,
  VerbGroupView,
} from "@shigomori/ui/views/palette/PaletteVerbsView.tsx";
import {
  PaletteDialogView,
  PickedChipView,
} from "@shigomori/ui/views/palette/WorktreePaletteView.tsx";
import { ProjectIconView } from "@shigomori/ui/views/shared/ProjectIconView.tsx";
import { WorktreeKindIconView } from "@shigomori/ui/views/shared/WorktreeKindIconView.tsx";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { forests, LOCAL_DEVICE_ID } from "../fake-host/fixtures";
import { unposedPullRequests } from "../fake-host/pullRequestFixtures";
import { SceneDialog, SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";
import { projectIconSrc, projectNamed } from "./world";

const noop = () => {};
const QUERY = "port";
const NOW = Date.now();
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const POOL = projectNamed(LOCAL_DEVICE_ID, "port-pool");
const WORKTREES: Worktree[] = forests[LOCAL_DEVICE_ID]?.worktrees[SM.id] ?? [];
const PRS = unposedPullRequests(SM.id) as Record<string, PaletteEntry["pr"]>;

const entryOf = (worktree: Worktree): PaletteEntry => ({
  key: `wt:${worktree.id}`,
  worktree,
  project: SM,
  device: undefined,
  mirror: undefined,
  pr: PRS[worktree.branch],
  hidden: false,
  sunk: false,
});

const icon = (project: Project, size = "size-4") => (
  <ProjectIconView
    src={projectIconSrc(project.name)}
    name={project.name}
    className={size}
  />
);

const ROWS: PaletteRow[] = [
  ...WORKTREES.filter((w) => /port|pool/.test(w.branch + w.name)).map(
    (w): PaletteRow => ({
      kind: "worktree",
      key: `wt:${w.id}`,
      entry: entryOf(w),
    }),
  ),
  {
    kind: "project",
    key: `project:${POOL.id}`,
    item: {
      key: `project:${POOL.id}`,
      project: POOL,
      device: undefined,
      lead: undefined,
      localProject: POOL,
      worktreeCount: 1,
      deviceCount: 1,
    } satisfies PaletteProject,
  },
  {
    kind: "page",
    key: "page:ports",
    page: {
      key: "page:ports",
      label: "Port pool",
      icon: Settings,
      parent: "Settings",
      open: noop,
    } satisfies PalettePage,
  },
  { kind: "create", key: "create:port", branch: "port", targets: [SM] },
];

function rowContent(row: PaletteRow): ReactNode {
  switch (row.kind) {
    case "worktree":
      return (
        <WorktreeRowView
          entry={row.entry}
          query={QUERY}
          now={NOW}
          status={undefined}
          showBadge
          icon={icon(row.entry.project)}
          kindIcon={
            <WorktreeKindIconView
              worktree={row.entry.worktree}
              allowAgentWorking
            />
          }
        />
      );
    case "project":
      return (
        <ProjectRowView
          item={row.item}
          query={QUERY}
          icon={icon(row.item.project)}
        />
      );
    case "page":
      return <PageRowView page={row.page} query={QUERY} />;
    case "create":
      return (
        <CreateRowView
          branch={row.branch}
          projectName={SM.name}
          base="main"
          creating={false}
        />
      );
  }
}

const GROUPS: [string, PaletteRow["kind"]][] = [
  ["Worktrees", "worktree"],
  ["Projects", "project"],
  ["Pages", "page"],
  ["Create", "create"],
];

const list = (picked: string | null) =>
  GROUPS.map(([heading, kind]) => (
    <PaletteGroupView key={kind} heading={heading}>
      {ROWS.filter((r) => r.kind === kind).map((row) => (
        <PaletteItemView
          key={row.key}
          value={row.key}
          selected={row.key === picked}
          onSelect={noop}
        >
          {rowContent(row)}
        </PaletteItemView>
      ))}
    </PaletteGroupView>
  ));

const FIRST = ROWS[0];

function verbs() {
  const entry = FIRST?.kind === "worktree" ? FIRST.entry : undefined;
  return (
    <>
      <VerbGroupView
        heading="Go to"
        query=""
        verbs={[
          {
            key: "detail",
            label: "Open worktree",
            icon: iconOf(Folder),
            listKeys: "↩",
            run: noop,
          },
          {
            key: "diff",
            label: "Open changes",
            icon: iconOf(FileDiff),
            listKeys: "⌘↩",
            run: noop,
          },
          ...(entry?.pr
            ? [
                {
                  key: "pr",
                  label: `Open pull request #${entry.pr.number}`,
                  icon: iconOf(GitPullRequest),
                  run: noop,
                },
              ]
            : []),
        ]}
      />
      <PaletteGroupView heading="Scripts">
        <ScriptVerbView
          name="dev"
          command="vite"
          busy
          disabled={false}
          tip="vite"
          onSelect={noop}
        />
        <ScriptVerbView
          name="test"
          command="vitest run"
          busy={false}
          disabled={false}
          tip="vitest run"
          onSelect={noop}
        />
      </PaletteGroupView>
      <VerbGroupView
        heading="More"
        query=""
        verbs={[
          {
            key: "copy-path",
            label: "Copy path",
            icon: iconOf(Copy),
            run: noop,
          },
        ]}
      />
    </>
  );
}

function palette(picked: boolean) {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="projects" open />}
      pathname="/projects"
      overlays={
        <SceneDialog className="h-full max-w-3xl">
          <PaletteDialogView
            picked={picked}
            highlighted={picked ? "detail" : (FIRST?.key ?? "")}
            onHighlight={noop}
            chip={
              picked &&
              FIRST && (
                <PickedChipView
                  row={FIRST}
                  icon={
                    FIRST.kind === "worktree" &&
                    icon(FIRST.entry.project, "size-3")
                  }
                  onBack={noop}
                />
              )
            }
            query={picked ? "" : QUERY}
            onQueryChange={noop}
            onInputKeyDown={noop}
            list={list(picked ? (FIRST?.key ?? null) : null)}
            emptyList="No worktrees match."
            verbs={verbs()}
            current={FIRST?.kind}
          />
        </SceneDialog>
      }
    />
  );
}

// The palette finding "port".
export function PaletteScene() {
  return palette(false);
}

// The first row picked, its verbs holding the keys.
export function PalettePickedScene() {
  return palette(true);
}
