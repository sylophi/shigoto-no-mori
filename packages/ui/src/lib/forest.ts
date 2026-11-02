// What the sidebar, the inbox, the home grid and the palette build their
// rows from, as the app's hooks read it: every device's projects as
// items, and this device's mirrors. The fixture world builds the same.
// And what every one of those builders reads off it alike: a group's
// key, a row's key and the fold a worktree sits behind.
import { MACHINE_FALLBACK_ICON } from "@shigomori/contracts/deviceIcon";
import {
  isAgentWorking,
  type Project,
  type PullRequest,
  type ShigomoriConfig,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { peerProjectKey } from "@shigomori/contracts/schemas/config";
import { isHiddenByPrefix } from "@shigomori/contracts/sharedSettings";
import type { SidebarDeviceBadge } from "../views/sidebar/DeviceBadgeView.tsx";
import type { GroupShelf, InboxShelf } from "../views/sidebar/sidebarRow.ts";
import { UNNAMED_DEVICE } from "./deviceRoster.ts";
import { showPrimaryInInbox } from "./showPrimaryInInbox.ts";

// One read per project, positionally aligned with the projects it was
// asked for (the app's useAllProject… fan-outs).
type ProjectReads<T> = readonly {
  readonly data: T | undefined;
  readonly error: Error | null;
  readonly isLoading: boolean;
  readonly isPending: boolean;
}[];

export type ProjectWorktreeQueries = ProjectReads<readonly Worktree[]>;
// Branch -> PR, per project.
export type ProjectPullRequestQueries = ProjectReads<
  Record<string, PullRequest>
>;
export type ProjectShigomoriConfigQueries =
  ProjectReads<ShigomoriConfig | null>;

// A device as the forest's items carry it: its badge, and whether it
// is the machine this window runs on.
export interface ForestDevice extends SidebarDeviceBadge {
  isThisDevice: boolean;
}

// What a key spelled per device reads off it.
export type DeviceRef = Pick<ForestDevice, "deviceId" | "isThisDevice">;

// One project on one device, with what every view reads off it. The
// same shape for this machine's projects and every peer's, so a
// builder files them alike.
export interface ForestItem {
  device: ForestDevice;
  project: Project;
  // What the device last listed. Kept through a failed refetch, which
  // the tree answers with its error row and the inbox looks past.
  worktrees: readonly Worktree[];
  // Whether the listing is in. Only this machine's answers anything but
  // ready: a peer's rows are its last known state either way.
  listing: "ready" | "loading" | "error";
  // Branch -> PR, what the pills, the stacks and the inbox's merged
  // shelf read. Empty until it lands.
  pullRequests: Record<string, PullRequest>;
  // The project's inbox opt-in for its primary checkout
  // (ShigomoriConfigSchema.showPrimaryInInbox). Undefined while unread,
  // which for a peer is whenever the inbox isn't showing.
  showPrimaryInInbox: boolean | undefined;
}

// A worktree wherever it is. Its id is only unique on its device: a
// repo at the same path on two machines has the same ids on both.
export interface WorktreeAt {
  deviceId: string;
  worktreeId: string;
}

// What the builders look a worktree up by, on any device.
export const worktreeAt = (deviceId: string, worktreeId: string) =>
  `${deviceId}/${worktreeId}`;

// A mirrored pair as the views fold it: one worktree on two machines,
// drawn as the kept side's row, which wears the folded side's device.
export interface MirrorPair {
  kept: WorktreeAt;
  folded: WorktreeAt;
}

// The pairs as the builders look them up, by worktreeAt: the kept side
// each folded worktree folds into, and the folded side each kept
// worktree stands for.
export function mirrorPairsOf(pairs: readonly MirrorPair[]): {
  keptOf: Map<string, string>;
  foldedOf: Map<string, WorktreeAt>;
} {
  const keptOf = new Map<string, string>();
  const foldedOf = new Map<string, WorktreeAt>();
  for (const { kept, folded } of pairs) {
    const keptAt = worktreeAt(kept.deviceId, kept.worktreeId);
    keptOf.set(worktreeAt(folded.deviceId, folded.worktreeId), keptAt);
    foldedOf.set(keptAt, folded);
  }
  return { keptOf, foldedOf };
}

// The badge a kept row wears for the device its pair folded away: the
// device's own when the registry knows it (its label and tone), else
// unnamed. Shared by the builders so a pair reads the same in each.
export function mirrorBadgeOf(
  folded: WorktreeAt | undefined,
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>,
): SidebarDeviceBadge | undefined {
  if (folded === undefined) return undefined;
  return (
    deviceBadges.get(folded.deviceId) ?? {
      deviceId: folded.deviceId,
      label: UNNAMED_DEVICE,
      icon: MACHINE_FALLBACK_ICON,
      tone: "slate",
      reachable: false,
    }
  );
}

// This device's worktree in a mirrored pair, in its project, with the
// project's primary opt-in (showPrimaryInInbox), undefined while unread.
export interface LocalSide {
  device: ForestDevice;
  worktree: Worktree;
  project: Project;
  showPrimaryInInbox: boolean | undefined;
}

// This device's sides of its pairs with a peer, by worktreeAt, for the
// device filter narrowed to that peer. A pair is one worktree on two
// machines, so it is on either one's filter: the builders list this
// device's side among the peer's rows as they do under every device,
// and the peer's row folds into it by the same rule. A listing not in
// yet, or failed, holds none.
export function localSidesWith(
  peerDeviceId: string,
  mirrors: readonly MirrorPair[],
  device: ForestDevice,
  projects: readonly Project[],
  worktreeQueries: ProjectWorktreeQueries,
  configQueries: ProjectShigomoriConfigQueries,
): Map<string, LocalSide> {
  const paired = new Set(
    mirrors
      .filter((pair) => pair.folded.deviceId === peerDeviceId)
      .map((pair) => pair.kept.worktreeId),
  );
  const sides = new Map<string, LocalSide>();
  projects.forEach((project, i) => {
    const query = worktreeQueries[i];
    if (project.pathExists === false || query?.error) return;
    for (const worktree of query?.data ?? []) {
      if (!paired.has(worktree.id)) continue;
      sides.set(worktreeAt(device.deviceId, worktree.id), {
        device,
        worktree,
        project,
        showPrimaryInInbox: showPrimaryInInbox(configQueries[i]?.data),
      });
    }
  });
  return sides;
}

// Which fold a worktree sits behind in its group, if any. An agent's
// working mark comes first, when it counts (isAgentWorking): it says
// the worktree isn't ready to look at yet, wherever it was filed.
// Shelving is the user's own call, so it outranks the prefixes. The
// inbox files by the same rule.
export function groupShelfOf(
  worktree: Worktree,
  prefixes: readonly string[],
  allowAgentWorking: boolean,
): GroupShelf | null {
  if (isAgentWorking(worktree, allowAgentWorking)) return "agentWorking";
  if (worktree.shelved) return "shelved";
  return isHiddenByPrefix(worktree, prefixes) ? "hidden" : null;
}

// Which inbox shelf a worktree sits on, null for the live box. Its own
// fold (groupShelfOf) outranks mergedness: a shelved branch that also
// merged stays where the user filed it, and the hidden prefixes are a
// filing made ahead of time. Merged is into the primary or by its pull
// request (a squash leaves the branch unmerged). A primary is always
// live: it can't be shelved, and a merged PR on whatever branch it
// happens to have checked out doesn't make the project's root "done".
// The palette sinks by it too.
export function worktreeShelfOf(
  worktree: Worktree,
  pr: PullRequest | undefined,
  prefixes: readonly string[],
  allowAgentWorking: boolean,
): InboxShelf | null {
  if (worktree.isPrimary) return null;
  const shelf = groupShelfOf(worktree, prefixes, allowAgentWorking);
  if (shelf !== null) return shelf;
  if (worktree.mergedIntoPrimary || pr?.state === "MERGED") return "merged";
  return null;
}

// The key a group goes by: what every device's checkouts of a repo are
// grouped under, and what the shell keeps the open project, its folds
// and its pin by. The repo identity when the project has one. A peer's
// project with no identity can only group with itself, so its device
// names it (peerProjectKey). This machine's project with none, or
// missing on disk, is its own group, by id: a missing one takes none
// of the peers' checkouts, which are alive and belong under their own
// header. One still loading groups by identity all the same, so the
// peers' checkouts stay under it.
export function projectGroupKey(project: Project, device: DeviceRef): string {
  if (!device.isThisDevice)
    return project.identity ?? peerProjectKey(device.deviceId, project.id);
  return project.pathExists !== false && project.identity != null
    ? project.identity
    : project.id;
}

// The key an item's project groups under (projectGroupKey).
export const groupKeyOf = ({ project, device }: ForestItem) =>
  projectGroupKey(project, device);

// The groups a forest's items fall into, in the items' order: one per
// group key, every device's checkout of a repo together, led by the
// first. Items come this machine's first, so a group this machine holds
// is led by its checkout. A repo registered twice here is two groups
// under one key, the later going by its project's id, the one thing
// that can't collide with a key or another project here.
export interface ForestGroup {
  id: string;
  key: string;
  items: [ForestItem, ...ForestItem[]];
}

export function forestGroups(items: readonly ForestItem[]): ForestGroup[] {
  const groups: ForestGroup[] = [];
  const byKey = new Map<string, ForestGroup>();
  for (const item of items) {
    const key = groupKeyOf(item);
    const held = byKey.get(key);
    const again =
      item.device.isThisDevice &&
      held?.items.some((other) => other.device.isThisDevice);
    if (held && !again) {
      held.items.push(item);
      continue;
    }
    const group: ForestGroup = {
      id: held ? item.project.id : key,
      key,
      items: [item],
    };
    if (!held) byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

// A worktree's row key wherever it lives: this machine's or a peer's,
// whose is device-qualified (worktreeAt). One spelling for the tree,
// the inbox and the palette, so a worktree has one identity in all
// three, and the one the palette's visits are kept by.
export const worktreeRowKey = (device: DeviceRef, worktreeId: string) =>
  device.isThisDevice
    ? `w:${worktreeId}`
    : `rw:${device.deviceId}:${worktreeId}`;
