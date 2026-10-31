import type { Project, ProjectSortMode } from "@shigomori/contracts/schemas";
import {
  claimsPeers,
  projectGroupKey,
  type RemoteForestItem,
  remoteGroupId,
} from "../../lib/forest.ts";
import { sortByProject } from "../../lib/sortProjects.ts";
import { type Owner, ownerOf } from "./sidebarRow.ts";

// Group rank by group id. A repo this machine holds is also ranked
// under the peer-only id it would have, so narrowed to a peer that
// holds it too, the peer's group keeps the local project's place. And
// owner rank and header label by owner key (ownerOf), for the list
// split by owner. And the pinned groups' keys (projectGroupKey), which
// lead the list wherever their rank puts them. And the folder each
// group is filed in, by group key, which gathers the groups of one
// owner filed in the same one under a header, and those headers.
export interface ProjectGroupOrder {
  groups: ReadonlyMap<string, number>;
  owners: ReadonlyMap<string, { rank: number; label: string }>;
  pinned: ReadonlySet<string>;
  folders: ReadonlyMap<string, string>;
  filed: Filed;
}

// Where each group sits in the tree, decided over every device's
// projects before the device filter narrows them, so picking a device
// only drops groups and never reshuffles the rest. A repo held on
// several devices sorts as one project: its newest use on any of them,
// and its uses on all of them summed. The manual sort has only this
// machine's arranged order to go by, so the repos only peers hold
// trail it in the order they were merged. An owner sits where its
// best-ranked project does, so a usage sort puts the owner of the
// project worked on most first, except under the alphabetical sort,
// where the owners go by label. A label is the owner's name, with its
// host only when the name is an owner on another host too, decided
// over every device too so picking one never relabels a header.
export function projectGroupOrder({
  projects,
  remote,
  sortMode,
  pinned,
  folders,
}: {
  // This machine's projects as buildSidebarRows is handed them, so a
  // repo registered twice here has its peers claimed by the same
  // project in both passes.
  projects: readonly Project[];
  remote: readonly RemoteForestItem[];
  sortMode: ProjectSortMode;
  pinned: ReadonlySet<string>;
  folders: ReadonlyMap<string, string>;
}): ProjectGroupOrder {
  const { claimed, peerOnly } = claimRemote(projects, remote);
  const entries = projects.map((project, i) => ({
    groupKey: projectGroupKey(project, undefined),
    groupIds: claimsPeers(project)
      ? [project.id, remoteGroupId(project.identity)]
      : [project.id],
    project: withMergedUsage(project, claimed[i] ?? []),
  }));
  for (const [groupKey, [first, ...rest]] of peerOnly) {
    if (!first) continue;
    entries.push({
      groupKey,
      groupIds: [remoteGroupId(groupKey)],
      project: withMergedUsage(first.project, rest),
    });
  }
  const groups = new Map<string, number>();
  // Owners by key, in the order their projects lead them in.
  const owners = new Map<string, Owner>();
  sortByProject(entries, sortMode, (entry) => entry.project).forEach(
    (entry, rank) => {
      // A repo registered twice here keeps its first project's place.
      for (const id of entry.groupIds)
        if (!groups.has(id)) groups.set(id, rank);
      const owner = ownerOf(entry.project);
      if (owner && !owners.has(owner.key)) owners.set(owner.key, owner);
    },
  );
  const seen = new Set<string>();
  const onTwoHosts = new Set<string>();
  for (const { name } of owners.values()) {
    const folded = name.toLowerCase();
    if (seen.has(folded)) onTwoHosts.add(folded);
    seen.add(folded);
  }
  const labeled = [...owners].map(
    ([key, { host, name }]) =>
      [
        key,
        onTwoHosts.has(name.toLowerCase()) ? `${host}/${name}` : name,
      ] as const,
  );
  const ranked =
    sortMode === "alphabetical"
      ? labeled.toSorted(([, a], [, b]) => a.localeCompare(b))
      : labeled;
  return {
    groups,
    owners: new Map(ranked.map(([key, label], rank) => [key, { rank, label }])),
    pinned,
    folders,
    filed: filedFolders(entries, folders),
  };
}

// Over every device's projects too, so a folder's rename reaches the
// projects the device filter leaves out.
function filedFolders(
  entries: readonly { groupKey: string; project: Project }[],
  folders: ReadonlyMap<string, string>,
): Filed {
  const filed = new Map<string, Map<string, string[]>>();
  const named = entries.flatMap((entry) => {
    const name = folders.get(entry.groupKey);
    return name === undefined ? [] : [{ ...entry, name }];
  });
  for (const { groupKey, project, name } of named.toSorted((a, b) =>
    a.name.localeCompare(b.name),
  ))
    for (const section of [ALL_KEY, ownerKeyOf(project)]) {
      const byName = filed.get(section) ?? new Map<string, string[]>();
      filed.set(section, byName);
      const keys = byName.get(name) ?? [];
      byName.set(name, keys);
      // A repo registered twice here is two entries under one key.
      if (!keys.includes(groupKey)) keys.push(groupKey);
    }
  return filed;
}

// One project's usage with every other checkout of it folded in: the
// newest use anywhere, and the uses everywhere summed.
function withMergedUsage(
  project: Project,
  others: readonly RemoteForestItem[],
): Project {
  return {
    ...project,
    lastUsed: Math.max(
      project.lastUsed ?? 0,
      ...others.map((item) => item.project.lastUsed ?? 0),
    ),
    recentCount: others.reduce(
      (sum, item) => sum + (item.project.recentCount ?? 0),
      project.recentCount ?? 0,
    ),
  };
}

// The peers' checkouts split between the groups: each local project's
// claim (aligned with `projects`), then the rest by group key. Remote
// items are grouped up front by repo identity (an identity-less
// project can only group with itself), and the local pass claims
// groups by `get` + `delete`, so whatever remains IS the leftover set
// and a group can never be claimed twice. A peer holding the repo with
// no worktrees to show still joins its group: it is a device the
// header's actions can create on, and a local project with nothing
// under it keeps its header too.
export function claimRemote(
  projects: readonly Project[],
  remote: readonly RemoteForestItem[],
): {
  claimed: RemoteForestItem[][];
  peerOnly: Map<string, RemoteForestItem[]>;
} {
  const peerOnly = new Map<string, RemoteForestItem[]>();
  for (const item of remote) {
    const groupKey = projectGroupKey(item.project, item.deviceId);
    const group = peerOnly.get(groupKey);
    if (group) group.push(item);
    else peerOnly.set(groupKey, [item]);
  }
  const claimed = projects.map((project) => {
    if (!claimsPeers(project)) return [];
    const items = peerOnly.get(project.identity) ?? [];
    peerOnly.delete(project.identity);
    return items;
  });
  return { claimed, peerOnly };
}

// A section's folders by name, in name order, each with the group keys
// filed in it. A section is an owner's (ownerOf), and the whole list is
// one too (ALL_KEY), for when it isn't split by owner.
export type Filed = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

export const ownerKeyOf = (project: Project) =>
  ownerOf(project)?.key ?? NO_OWNER_KEY;

// The section of the projects with no owner, and the one section of a
// list not split by owner. Not valid owner keys (those always hold a
// slash), so no owner can take them.
export const NO_OWNER_KEY = "none";
export const ALL_KEY = "all";
