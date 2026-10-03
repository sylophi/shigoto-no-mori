// The worktree page's data (../WorktreeDetailPane.tsx).
import {
  type FooterLeadingVerb,
  canTransplantAway,
  transferIdentity,
} from "@/components/worktreeDetail/FooterLeadingVerbView";
import {
  type LifecycleRow,
  lifecycleRowsOf,
} from "@/components/worktreeDetail/scripts/lifecycleRows";
import {
  type SortableEntry,
  sortEntries,
} from "@/components/worktreeDetail/scripts/sortPackageScripts";
import { mirrorEngineBlocker } from "@shared/ipc/modules/mirror";
import {
  type PullRequestStack,
  pullRequestStackFor,
  stackCleanupFor,
  trunkOf,
} from "@shared/pullRequestStack";
import type { Project, PullRequestDetail, Worktree } from "@shared/schemas";
import {
  forests,
  labPackageScriptSort,
  labPackageScripts,
  labPortPoolActive,
  labShigomoriConfig,
} from "../../fixtures";
import { labUnposedPullRequestDetail } from "../../pullRequestFixtures";
import { pullRequestsOf } from "./index";

// Every checkout of a project's repo across the account's devices, with
// whether that device takes commands from this one.
function checkoutsOf(project: Project): {
  worktrees: Worktree[];
  grantsCaller: boolean;
}[] {
  return Object.values(forests).flatMap((forest) =>
    forest.projects
      .filter(
        (candidate) =>
          candidate.id === project.id ||
          (project.identity != null && candidate.identity === project.identity),
      )
      .map((candidate) => ({
        worktrees: forest.worktrees[candidate.id] ?? [],
        grantsCaller: forest.grantsCaller,
      })),
  );
}

// A branch's PR as the worktree page reads it, with the stack it sits
// in (the whole chain, as the stack list draws it).
export function pullRequestDetailOf(
  project: Project,
  branch: string,
): { pr: PullRequestDetail | null; stack: PullRequestStack | null } {
  const own = Object.values(forests).find((forest) =>
    forest.projects.some((candidate) => candidate.id === project.id),
  );
  return {
    pr: labUnposedPullRequestDetail(project.id, branch),
    stack: pullRequestStackFor(
      pullRequestsOf(project.id),
      branch,
      trunkOf(own?.worktrees[project.id]),
    ),
  };
}

// How many worktrees the closed PR box's stack cleanup takes: the
// merged layers' worktrees on every device that takes commands.
export function stackCleanupCountOf(
  project: Project,
  stack: PullRequestStack | null,
): number {
  if (!stack) return 0;
  return checkoutsOf(project)
    .filter(({ grantsCaller }) => grantsCaller)
    .reduce(
      (count, { worktrees }) =>
        count + (stackCleanupFor(stack, worktrees)?.worktrees.length ?? 0),
      0,
    );
}

// The package.json scripts in the order the project sorts them, which
// the Launch row and the Scripts section share.
export function packageScriptsOf(): SortableEntry[] {
  return sortEntries(
    Object.entries(labPackageScripts.scripts),
    labPackageScriptSort,
    labPackageScripts.usage,
    [],
  );
}

// The Scripts section's lifecycle rows for a worktree.
export function lifecycleOf(worktree: Worktree): LifecycleRow[] {
  return lifecycleRowsOf({
    scripts: labShigomoriConfig.scripts,
    portPoolActive: labPortPoolActive,
    path: worktree.path,
  });
}

// The footer's leading verbs on this machine's own worktree page:
// Files and Ports, then the ways to another device. The lab's mirror
// engine is stopped until a mirror starts, so Mirror to… is off.
export function footerVerbsOf(
  worktree: Worktree,
  project: Project,
): FooterLeadingVerb[] {
  const verbs: FooterLeadingVerb[] = [{ kind: "files" }, { kind: "ports" }];
  if (transferIdentity(worktree, project) === null) return verbs;
  verbs.push({
    kind: "mirrorTo",
    disabledReason: mirrorEngineBlocker("stopped"),
  });
  if (canTransplantAway(worktree)) verbs.push({ kind: "transplantTo" });
  return verbs;
}
