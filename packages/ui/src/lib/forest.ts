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

// A mirrored pair as the sidebar folds it: the peer's row (device,
// worktree) that folds into a local row, and the peer device the local
// row wears. A session pairs its local original with the peer's copy.
// A served stream pairs the served copy with the peer's original, when
// the peer named it.
export type MirrorLink = {
  peerDeviceId: string;
  peerWorktreeId: string;
  localWorktreeId: string;
};

// This device's worktree in a mirrored pair, in its project, with the
// project's primary opt-in (showPrimaryInInbox), undefined while unread.
export interface LocalSide {
  worktree: Worktree;
  project: Project;
  showPrimaryInInbox: boolean | undefined;
}

// This device's sides of its pairs with a peer, by worktree id, for the
// device filter narrowed to that peer. A pair is one worktree on two
// machines, so it is on either one's filter: the builders list this
// device's side among the peer's rows as they do under every device,
// and the peer's row folds into it by the same rule. A listing not in
// yet, or failed, holds none.
export function localSidesWith(
  peerDeviceId: string,
  mirrors: readonly MirrorLink[],
  projects: readonly Project[],
  worktreeQueries: ProjectWorktreeQueries,
  configQueries: ProjectShigomoriConfigQueries,
): Map<string, LocalSide> {
  const paired = new Set(
    mirrors
      .filter((link) => link.peerDeviceId === peerDeviceId)
      .map((link) => link.localWorktreeId),
  );
  const sides = new Map<string, LocalSide>();
  projects.forEach((project, i) => {
    const query = worktreeQueries[i];
    if (project.pathExists === false || query?.error) return;
    for (const worktree of query?.data ?? []) {
      if (!paired.has(worktree.id)) continue;
      sides.set(worktree.id, {
        worktree,
        project,
        showPrimaryInInbox: showPrimaryInInbox(configQueries[i]?.data),
      });
    }
  });
  return sides;
}

// The pairs as the builders look them up: the local worktree each
// peer row (device, worktree) folds into, and the pair each local
// worktree is in.
export function mirrorPairsOf(mirrors: readonly MirrorLink[]): {
  peerRowsFolded: Map<string, string>;
  peerOfLocal: Map<string, MirrorLink>;
} {
  const peerRowsFolded = new Map<string, string>();
  const peerOfLocal = new Map<string, MirrorLink>();
  for (const link of mirrors) {
    peerRowsFolded.set(
      remoteWorktreeKey(link.peerDeviceId, link.peerWorktreeId),
      link.localWorktreeId,
    );
    peerOfLocal.set(link.localWorktreeId, link);
  }
  return { peerRowsFolded, peerOfLocal };
}

// The badge a local row wears for the peer it is mirrored with: the
// peer's own when the registry knows it (its label and tone), else
// unnamed. Shared by both builders so a pair reads the same in each.
export function mirrorBadgeLookup(
  peerOfLocal: ReadonlyMap<string, MirrorLink>,
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>,
): (worktree: Worktree) => SidebarDeviceBadge | undefined {
  return (worktree) => {
    const peer = peerOfLocal.get(worktree.id)?.peerDeviceId;
    if (peer === undefined) return undefined;
    return (
      deviceBadges.get(peer) ?? {
        deviceId: peer,
        label: UNNAMED_DEVICE,
        icon: MACHINE_FALLBACK_ICON,
        tone: "slate",
        reachable: false,
      }
    );
  };
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

// Whether a local project takes the peers' checkouts of its repo.
// Claimed by identity even while still loading, so the project's
// remote worktrees stay under it instead of reappearing as a duplicate
// peer-only group. A missing local project
// claims nothing: its remote counterpart is alive and belongs under
// its own header.
export const claimsPeers = (
  project: Project,
): project is Project & { identity: string } =>
  project.pathExists !== false && project.identity != null;

// The key a group goes by: what the peers' checkouts are grouped
// under, and what the shell keeps the open project and the group's
// shelf reveals by. The repo identity when the project has one, so
// every checkout of a repo is one group. A
// peer's project with no identity can only group with itself, so its
// device names it (peerProjectKey). A local project that claims no
// peers (no identity, or missing on disk) is its own group, by id.
// `deviceId` is the peer holding the project, undefined for this
// machine's.
export function projectGroupKey(
  project: Project,
  deviceId: string | undefined,
): string {
  if (deviceId === undefined)
    return claimsPeers(project) ? project.identity : project.id;
  return project.identity ?? peerProjectKey(deviceId, project.id);
}

// The key an item's project groups under (projectGroupKey).
export const groupKeyOf = ({ project, device }: ForestItem) =>
  projectGroupKey(project, device.isThisDevice ? undefined : device.deviceId);

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

// Device-qualified: the same repo pulled to two machines can carry
// the same worktree id on both. Shared with the inbox builder so a
// peer's row has one key in both views.
export const remoteWorktreeKey = (deviceId: string, worktreeId: string) =>
  `rw:${deviceId}:${worktreeId}`;

// A worktree's row key wherever it lives: this machine's (deviceId
// undefined) or a peer's. One spelling for the tree, the inbox and the
// ⌘K palette, so a worktree has one identity in all three.
export const worktreeRowKey = (
  deviceId: string | undefined,
  worktreeId: string,
) =>
  deviceId === undefined
    ? `w:${worktreeId}`
    : remoteWorktreeKey(deviceId, worktreeId);
