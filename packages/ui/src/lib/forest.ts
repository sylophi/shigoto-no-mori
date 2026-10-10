// What the sidebar, the inbox, the home grid and the palette build their
// rows from, as the app's hooks read it: this device's per-project reads,
// its peers' forests and its mirrors. The fixture world builds the same.
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type {
  Project,
  PullRequest,
  ShigomoriConfig,
  Worktree,
} from "@shigomori/contracts/schemas";
import type { StatusTone } from "../primitives/status-dot.tsx";

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

// One remote project's slice, flat because that is exactly the unit
// the row builder merges by repo identity.
export interface RemoteForestItem {
  deviceId: string;
  deviceLabel: string;
  // What the device looks like, for its badge on the rows.
  deviceIcon: DeviceIcon;
  // False when the device is not currently reachable: its rows are the
  // cache's last known state, and the tree fades them rather than
  // hiding work that still exists on that machine.
  reachable: boolean;
  // The device's connection tone, so a badge for it reads the same as
  // its chip on the account page.
  tone: StatusTone;
  project: Project;
  worktrees: readonly Worktree[];
  // Branch -> PR on that device, what its own sidebar reads for the
  // pills and the inbox's merged shelf. Empty until it lands.
  pullRequests: Record<string, PullRequest>;
  // That project's inbox opt-in for its primary checkout
  // (ShigomoriConfigSchema.showPrimaryInInbox), read off the peer so a
  // project shows its root the same way in every sidebar. Undefined
  // until the config is read, which is only while the inbox shows.
  showPrimaryInInbox: boolean | undefined;
  // A failed worktree listing, folded into the sidebar's coalesced
  // fan-out toast beside the local failures.
  worktreesError: boolean;
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
