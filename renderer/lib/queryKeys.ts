// Central registry of TanStack Query keys. Every queryKey in the
// renderer should come from here so renames and prefix-based
// invalidations can be audited in one place. Keys are camelCase tuples;
// shared prefixes (e.g. "githubCli") let one invalidateQueries call
// knock out everything in that domain.
//
// Two scopes. Host-scoped keys describe a machine's git, fs,
// processes, worktrees or config (including preferences that persist
// in the host's per-root state.json) and open with a constant "host"
// sentinel followed by a device id, so a second device's data can
// enter the cache without colliding and scope stays decidable from the
// tuple alone. Client-scoped keys belong to this app instance alone
// (clientConfig, account, portForwards) and never get either.
import type { QueryClient } from "@tanstack/react-query";

const PR_BRANCH_SCOPE = "branch";
const HOST_SCOPE = "host";

// The local device's id, delivered synchronously by the preload bridge
// (main passes it via additionalArguments), so it is a constant before
// any module can build a key.
export const localDeviceId: string = window.api.deviceId;

// A host-scoped key builder for an ARBITRARY device id, the tuple body
// behind every host builder below. A remote device's data caches under
// its OWN id (its welcome deviceId), in exactly the families the local
// builders use, so it sits beside this machine's data without
// colliding. queryKeyDomain still classifies these correctly: it reads
// the domain off the third slot whatever id sits in the second.
export function hostKeysFor(
  deviceId: string,
): <const T extends readonly unknown[]>(
  ...segments: T
) => readonly ["host", string, ...T] {
  return (...segments) => [HOST_SCOPE, deviceId, ...segments];
}

// Domain segment of a key: the first element, or the third on
// host-scoped keys, which carry the sentinel and a device id ahead of
// it. Keyed off the sentinel, not the local id, so a remote device's
// key classifies the same as ours. Predicates that classify keys by
// domain go through this instead of indexing around the prefix by
// hand.
export function queryKeyDomain(queryKey: readonly unknown[]): unknown {
  return queryKey[0] === HOST_SCOPE ? queryKey[2] : queryKey[0];
}

// The device id a host-scoped key is bound to, or undefined for a
// client-scoped key. Keyed off the sentinel so the second slot is read
// only where it holds a device id, keeping the sentinel encapsulated for
// predicates that must tell a local host key from a remote one.
export function hostKeyDeviceId(queryKey: readonly unknown[]): unknown {
  return queryKey[0] === HOST_SCOPE ? queryKey[1] : undefined;
}

// The full builder set, bound to one device id. Host builders key
// through hostKeysFor(deviceId), so a registry names exactly one
// device's cache slots. The client-scoped builders carry no device id
// and build the same tuple in every registry. They live here anyway so
// one object answers for the whole key namespace wherever it came from.
function buildQueryKeys(deviceId: string) {
  const host = hostKeysFor(deviceId);
  return {
    globalConfig: () => host("globalConfig"),

    projects: () => host("projects"),
    projectsSort: () => host("projectsSort"),
    projectsCollapsed: () => host("projectsCollapsed"),
    sidebarView: () => host("sidebarView"),
    projectIcon: (projectId: string) => host("projectIcon", projectId),

    shigomoriConfig: (projectId: string | null) => host("shigomori", projectId),

    worktrees: (projectId: string | null) => host("worktrees", projectId),
    worktreeData: (projectId: string | null, worktreeId: string | null) =>
      host("worktreeData", projectId, worktreeId),
    worktreeDiff: (projectId: string, worktreeId: string | undefined) =>
      host("worktreeDiff", projectId, worktreeId),
    commitDiff: (
      projectId: string,
      worktreeId: string | undefined,
      hash: string,
    ) => host("commitDiff", projectId, worktreeId, hash),
    pickedWorktreeName: (projectId: string | null) =>
      host("pickedWorktreeName", projectId),

    // Tidy-the-forest data. Split in two because the git facts are cheap
    // and the disk walk is not: one key per worktree lets each size land
    // on its own instead of the page waiting for the slowest checkout.
    worktreeHygiene: (projectId: string | null) =>
      host("worktreeHygiene", projectId),
    worktreeDiskUsage: (projectId: string, worktreeId: string) =>
      host("worktreeDiskUsage", projectId, worktreeId),

    branches: (projectId: string | null) => host("branches", projectId),
    defaultBranch: (projectId: string | null) =>
      host("defaultBranch", projectId),
    branchCommits: (
      projectId: string,
      worktreeId: string,
      headHash: string | undefined,
    ) => host("branchCommits", projectId, worktreeId, headHash),

    packageScripts: (projectId: string | null, worktreeId: string | null) =>
      host("packageScripts", projectId, worktreeId),
    packageScriptSort: (projectId: string | null) =>
      host("packageScriptSort", projectId),

    portPoolInstalled: () => host("portPoolInstalled"),
    // The merged pool + custom port list with its liveness probe. Polled
    // while a detail page shows it, so a dev server starting or
    // stopping on the host shows up without a refetch trigger.
    worktreePorts: (projectId: string, worktreeId: string) =>
      host("worktreePorts", projectId, worktreeId),
    terrierReadiness: () => host("terrierReadiness"),
    cli: () => host("cli"),
    cliShell: () => host("cliShell"),
    portPoolActive: (projectId: string, worktreeId: string) =>
      host("portPoolActive", projectId, worktreeId),

    // Every "launchers" key: detected catalog plus the merged per-project
    // list. Invalidating launchersAll() prefix-matches both.
    launchersAll: () => host("launchers"),
    detectedLaunchers: () => host("launchers", "detected"),
    projectLaunchers: (projectId: string | null) =>
      host("launchers", projectId),

    // All GitHub CLI queries share the "githubCli" prefix so toggling the
    // integration can invalidate the whole subtree in one call.
    githubCliAll: () => host("githubCli"),
    githubCliReadiness: () => host("githubCli", "readiness"),
    repoMergeConfig: (projectId: string) =>
      host("githubCli", "repoMergeConfig", projectId),
    pullRequestDiff: (projectId: string, number: number | undefined) =>
      host("githubCli", "pullRequestDiff", projectId, number),
    // PR queries share a project-scoped prefix so invalidating
    // pullRequestsForProject cascades to both projectPullRequests and
    // any open worktreePullRequest.
    pullRequestsAll: () => host("githubCli", "pullRequests"),
    pullRequestsForProject: (projectId: string) =>
      host("githubCli", "pullRequests", projectId),
    projectPullRequests: (projectId: string) =>
      host("githubCli", "pullRequests", projectId, "project"),
    worktreePullRequest: (projectId: string, branch: string) =>
      host("githubCli", "pullRequests", projectId, PR_BRANCH_SCOPE, branch),
    pullRequestCandidates: (projectId: string) =>
      host("githubCli", "pullRequests", projectId, "candidates"),

    fsListDirectory: (path: string) => host("fs", "listDirectory", path),
    fsIsGitRepo: (path: string) => host("fs", "isGitRepo", path),

    carryOverListing: (projectId: string, relative: string) =>
      host("carryOver", "listing", projectId, relative),
    carryOverStats: (projectId: string, paths: string[]) =>
      host("carryOver", "stats", projectId, paths),
    worktreeIncludeStatus: (projectId: string | null) =>
      host("worktreeIncludeStatus", projectId),

    // Host-scoped: the payload (shigomoriRoot, rootDirName, homedir) is
    // a set of per-host facts served by the host-scoped runtime contract.
    runtimeInfo: () => host("runtime", "info"),

    // Host-scoped: the CALLING device's command-access verdict on this
    // host, served by the per-caller remoteAccess preflight. It caches
    // under the peer's own id; the local device is always granted and
    // never reaches this key.
    commandAccess: () => host("commandAccess"),

    // Client-scoped: the store lives in this app instance's userData, so
    // no host sentinel and no device id.
    clientConfig: () => ["clientConfig"] as const,

    // Client-scoped: the hub account credential lives in this app
    // instance's userData, not a host's state. Status and the device list
    // share the "account" prefix so the changed broadcast can invalidate
    // both at once.
    account: () => ["account"] as const,
    accountStatus: () => ["account", "status"] as const,
    accountDevices: () => ["account", "devices"] as const,
    // Whether this host accepts commands from the account's other
    // devices. Kept OUTSIDE the "account" prefix so the toggle (which
    // fans out on commandAccessChanged) invalidates only this query and
    // never thrashes status or the device list.
    accountCommandAccess: () => ["accountCommandAccess"] as const,

    // Host-scoped: the update is a fact about the machine the app runs
    // on, and a peer's Settings tab shows that device's state under its
    // own id. Seeded by updater:get and then driven by the updater:state
    // broadcast, which a remote scope receives over its direct session.
    updaterState: () => host("updater"),

    // Client-scoped: the port-forward engine (its listeners and conns)
    // lives in this app instance's main process, whichever device a
    // forward targets, so no host sentinel and no device id. One key
    // for the whole list, and the UI filters per device.
    portForwards: () => ["portForwards"] as const,
  } as const;
}

export type QueryKeyRegistry = ReturnType<typeof buildQueryKeys>;

// One registry per device id, so a registry is referentially stable for
// a device's lifetime and safe in dependency arrays and context values.
const registries = new Map<string, QueryKeyRegistry>();

export function queryKeysFor(deviceId: string): QueryKeyRegistry {
  const cached = registries.get(deviceId);
  if (cached) return cached;
  const built = buildQueryKeys(deviceId);
  registries.set(deviceId, built);
  return built;
}

// The local device's registry: for module-scope, broadcast-driven and
// deliberately local call sites, which always mean this machine's
// cache. Anything rendered under a HostScopeProvider must use the
// scoped registry from useHostScope instead.
export const queryKeys = queryKeysFor(localDeviceId);

// The "state on this device moved, refetch what you're showing" sweep,
// shared by both externalChange consumers: the local watcher
// subscription in renderer/index.tsx (with localDeviceId) and
// lib/remote/remoteHostWatch.ts (with the pinging device's id). Deliberately broad
// within its scope (the host debounces the signal and only active
// queries actually refetch), but some domains sit it out:
//
// - githubCli for scope AND cost: a disk change says nothing about
//   GitHub, and refetching PR lists here turns every ping into a burst
//   of gh network calls.
// - worktreeHygiene / worktreeDiskUsage for cost: both cache for 60s (a
//   sweep is several git calls or a directory walk per worktree) and
//   invalidation ignores staleTime. Focus, mount and the removal flow
//   still cover them.
// - runtime and updater: static per-host facts and that device's
//   updater state, which its own broadcast drives. No git-state change
//   touches either.
// - portForwards for the same reason as updater: the forward set is
//   this install's engine state, driven by its own changed broadcast,
//   and no host git-state ping moves it.
// - clientConfig for scope: the store lives in this app instance's
//   userData, so no host's state change can touch it. Including it
//   would defeat the query's staleTime Infinity on every ping.
// - account for the same two reasons: credential state lives outside
//   any forest and moves only on account:changed, and the status
//   query's staleTime Infinity would be defeated on every ping.
// - fs for loop-safety as well as relevance: a git-state ping says
//   nothing about a directory listing, and because fs reads are tagged
//   mutating (they ride the command grant), a ping-driven fs refetch on
//   a remote scope would itself trigger the host's resolved-mutation
//   ping, refetching forever.
const externalChangeExempt = new Set([
  "account",
  "clientConfig",
  // A permission verdict, not state: it moves only on a grant or
  // revoke on the host, never because that host's git state did.
  "commandAccess",
  "fs",
  "githubCli",
  "portForwards",
  "runtime",
  "updater",
  "worktreeHygiene",
  "worktreeDiskUsage",
]);

// The EXTERNAL-CHANGE sweep, scoped to one device. Host-scoped keys
// invalidate only when bound to THIS device id: a remote device's
// queries cache under its own id in the same host families, so a
// device-blind sweep would invalidate a peer's worktrees on a purely
// local change (and vice versa). Client-scoped keys carry no id and
// keep the domain-exempt behavior whichever device pinged. The
// exemptions above are the whole point of this entry: "state on that
// device moved" says nothing about GitHub, hygiene, forwards or the
// updater, so those sit the ping out. See invalidateDeviceSession for
// the sibling that must NOT sit them out.
export function invalidateHostDevice(
  queryClient: QueryClient,
  deviceId: string,
): void {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const keyDeviceId = hostKeyDeviceId(query.queryKey);
      if (keyDeviceId !== undefined && keyDeviceId !== deviceId) return false;
      return !externalChangeExempt.has(String(queryKeyDomain(query.queryKey)));
    },
  });
}

// The PROJECT-SCOPED sweep, for git:projectChanged: one project's git
// state moved on that device (a commit, a checkout, a ref written by
// any tool), so only the host keys carrying that project id refetch,
// under the same domain exemptions as the device-wide sweep. Every
// project-scoped host builder puts the project id in the fourth slot
// (right after the domain), which is what the match reads; keys shaped
// otherwise (a client key, a whole-host key, a githubCli sub-tree) do
// not carry a project id there and are left alone.
export function invalidateHostProject(
  queryClient: QueryClient,
  deviceId: string,
  projectId: string,
): void {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      if (hostKeyDeviceId(query.queryKey) !== deviceId) return false;
      if (query.queryKey[3] !== projectId) return false;
      return !externalChangeExempt.has(String(queryKeyDomain(query.queryKey)));
    },
  });
}

// The SESSION-LANDED sweep: a device's data wire just came up, so
// everything host-scoped for it is fetchable now and none of it was a
// moment ago. Same device-id scoping as invalidateHostDevice and
// deliberately NO domain exemption, because the exempt list is tuned
// for "that host's git state moved" and is exactly wrong here: runtime,
// githubCli, fs, portForwards, updater, worktreeHygiene and
// worktreeDiskUsage are the queries that hard-failed with "no direct
// connection" while the keeper was still dialing, so exempting them
// would skip precisely what needs refetching. Client-scoped keys are
// left alone in the other direction: they belong to this app instance,
// never to the peer, so a peer's session says nothing about them.
export function invalidateDeviceSession(
  queryClient: QueryClient,
  deviceId: string,
): void {
  void queryClient.invalidateQueries({
    predicate: (query) => hostKeyDeviceId(query.queryKey) === deviceId,
  });
}

// Matchers live beside the builders they mirror and share their segment
// constants: a predicate that indexes a key by hand silently stops
// matching the moment a segment moves, and nothing fails loudly.
// Deriving length and scope position from a sample built key keeps the
// match exact (a projectId literally named "branch" can't slip in) and
// immune to the builder growing at either end.
const sampleWorktreePullRequestKey = queryKeys.worktreePullRequest("p", "b");
const worktreePullRequestKeyLength = sampleWorktreePullRequestKey.length;
const prBranchScopeIndex =
  sampleWorktreePullRequestKey.indexOf(PR_BRANCH_SCOPE);

export function isWorktreePullRequestKey(query: {
  queryKey: readonly unknown[];
}): boolean {
  return (
    query.queryKey.length === worktreePullRequestKeyLength &&
    query.queryKey[prBranchScopeIndex] === PR_BRANCH_SCOPE
  );
}
