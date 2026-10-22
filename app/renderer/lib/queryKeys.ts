// Central registry of TanStack Query keys. Every queryKey in the
// renderer should come from here so renames and prefix-based
// invalidations can be audited in one place. Keys are camelCase tuples;
// shared prefixes (e.g. "githubCli") let one invalidateQueries call
// knock out everything in that domain.
//
// Two scopes. Host-scoped keys describe a machine's git, fs,
// processes, worktrees or config (including preferences that persist
// in the host's store) and open with a constant "host"
// sentinel followed by a device id, so a second device's data can
// enter the cache without colliding and scope stays decidable from the
// tuple alone. Client-scoped keys belong to this app instance alone
// (the account, the port forwards, the releases) and never get either.
import { refreshQueries } from "@/lib/askAgain";
import type { QueryClient } from "@tanstack/react-query";

const PR_BRANCH_SCOPE = "branch";
const HOST_SCOPE = "host";

// A host-scoped key builder for an ARBITRARY device id, the tuple body
// behind every host builder below. A remote device's data caches under
// its OWN id (its welcome deviceId), in exactly the families the local
// builders use, so it sits beside this machine's data without
// colliding. queryKeyDomain still classifies these correctly: it reads
// the domain off the third slot whatever id sits in the second.
function hostKeysFor(
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
function queryKeyDomain(queryKey: readonly unknown[]): unknown {
  return queryKey[0] === HOST_SCOPE ? queryKey[2] : queryKey[0];
}

// The device id a host-scoped key is bound to, or undefined for a
// client-scoped key. Keyed off the sentinel so the second slot is read
// only where it holds a device id, keeping the sentinel encapsulated for
// predicates that must tell a local host key from a remote one.
export function hostKeyDeviceId(queryKey: readonly unknown[]): unknown {
  return queryKey[0] === HOST_SCOPE ? queryKey[1] : undefined;
}

// The client-scoped builders: they carry no device id and build the
// same tuple whichever device a caller is looking at.
export const queryKeys = {
  // Client-scoped: the code highlighter holding a language, loaded in
  // this window whichever device the code came from.
  codeHighlighter: (lang: string) => ["codeHighlighter", lang] as const,

  // Client-scoped: the hub account credential lives in this app
  // instance's userData, not a host's state. Status and the device list
  // share the "account" prefix so the changed broadcast can invalidate
  // both at once.
  account: () => ["account"] as const,
  accountStatus: () => ["account", "status"] as const,
  accountDevices: () => ["account", "devices"] as const,

  // Client-scoped: the port-forward engine (its listeners and conns)
  // lives in this machine's host process, whichever device a
  // forward targets, so no host sentinel and no device id. One key
  // for the whole list, and the UI filters per device.
  portForwards: () => ["portForwards"] as const,

  // Client-scoped: the app's GitHub releases, one list for every
  // device, which the changelog measures each one's version against.
  releases: () => ["releases"] as const,
} as const;

// The full builder set, bound to one device id. Host builders key
// through hostKeysFor(deviceId), so a registry names exactly one
// device's cache slots. The client-scoped builders (queryKeys) come
// along, so one object answers for the whole key namespace wherever it
// came from.
function buildQueryKeys(deviceId: string) {
  const host = hostKeysFor(deviceId);
  return {
    projectIcon: (projectId: string) => host("projectIcon", projectId),

    shigomoriConfig: (projectId: string | null) => host("shigomori", projectId),

    worktreeData: (projectId: string | null, worktreeId: string | null) =>
      host("worktreeData", projectId, worktreeId),
    // The ignored files a transfer leaves behind on a source worktree
    // (sync:ignoredPaths), read by the transplant dialog.
    worktreeIgnored: (projectId: string, worktreeId: string) =>
      host("worktreeIgnored", projectId, worktreeId),
    // One folder of a worktree (sync:worktreeFolder), the mirror
    // dialog's picker of what stays behind and the files page's tree.
    worktreeFolder: (
      projectId: string,
      worktreeId: string,
      relative: string,
      ruleIgnored: boolean,
    ) => host("worktreeFolder", projectId, worktreeId, relative, ruleIgnored),
    // Every folder listing of one worktree, the prefix the files page's
    // refresh drops.
    worktreeFolders: (projectId: string, worktreeId: string) =>
      host("worktreeFolder", projectId, worktreeId),
    // One file of a worktree (worktrees:readFile), the files page's
    // viewer, and the prefix over all of a worktree's.
    worktreeFile: (projectId: string, worktreeId: string, path: string) =>
      host("worktreeFile", projectId, worktreeId, path),
    worktreeFiles: (projectId: string, worktreeId: string) =>
      host("worktreeFile", projectId, worktreeId),
    // One side of a media file in a diff (worktrees:readBlob).
    gitBlob: (
      projectId: string,
      worktreeId: string,
      oid: string,
      path: string,
    ) => host("gitBlob", projectId, worktreeId, oid, path),
    commitDiff: (
      projectId: string,
      worktreeId: string | undefined,
      hash: string,
    ) => host("commitDiff", projectId, worktreeId, hash),
    commitMessage: (
      projectId: string,
      worktreeId: string | undefined,
      hash: string | undefined,
    ) => host("commitMessage", projectId, worktreeId, hash),
    commitSummary: (
      projectId: string,
      worktreeId: string | undefined,
      hash: string,
    ) => host("commitSummary", projectId, worktreeId, hash),
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
      opts: { query?: string; from?: string },
    ) =>
      host(
        "branchCommits",
        projectId,
        worktreeId,
        headHash,
        opts.query ?? "",
        opts.from ?? "",
      ),
    stashDiff: (projectId: string, worktreeId: string, hash: string) =>
      host("stashDiff", projectId, worktreeId, hash),
    // What a branch changes against the primary branch.
    branchDiff: (projectId: string, worktreeId: string) =>
      host("branchDiff", projectId, worktreeId),
    // How a branch and another to bring in stand, while HEAD is here.
    mergePreview: (
      projectId: string,
      worktreeId: string,
      ref: string,
      headHash: string | undefined,
      countsOnly: boolean,
    ) => host("mergePreview", projectId, worktreeId, ref, headHash, countsOnly),

    packageScripts: (projectId: string | null, worktreeId: string | null) =>
      host("packageScripts", projectId, worktreeId),
    // Every worktree's listing of one project, which all carry the
    // project's launch row picks.
    packageScriptsAll: (projectId: string | null) =>
      host("packageScripts", projectId),
    packageScriptSort: (projectId: string | null) =>
      host("packageScriptSort", projectId),
    packageScriptOrder: (projectId: string | null) =>
      host("packageScriptOrder", projectId),

    portPoolInstalled: () => host("portPoolInstalled"),
    // The merged pool + custom port list with its liveness probe. Polled
    // while a detail page shows it, so a dev server starting or
    // stopping on the host shows up without a refetch trigger.
    terrierReadiness: () => host("terrierReadiness"),
    // The villager data (host/lib/VillagerData.ts): this device's own,
    // read by its own window only, so only the local registry's are
    // ever filled.
    villagerData: () => host("villagers", "status"),
    villagerProfiles: () => host("villagers", "profiles"),
    villagerFace: (slug: string) => host("villagers", "face", slug),
    cli: () => host("cli"),
    agents: () => host("agents"),
    cliShell: () => host("cliShell"),
    doctor: () => host("doctor"),
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
    githubOwners: () => host("githubCli", "owners"),
    githubRepos: () => host("githubCli", "repos"),
    repoMergeConfig: (projectId: string) =>
      host("githubCli", "repoMergeConfig", projectId),
    repoDescription: (projectId: string) =>
      host("githubCli", "repoDescription", projectId),
    remoteImage: (projectId: string, url: string) =>
      host("projects", "remoteImage", projectId, url),
    pullRequestDiff: (projectId: string, number: number | undefined) =>
      host("githubCli", "pullRequestDiff", projectId, number),
    // The create pull request dialog's reads.
    pullRequestDraft: (projectId: string, worktreeId: string, branch: string) =>
      host("githubCli", "pullRequestDraft", projectId, worktreeId, branch),
    pullRequestCompare: (projectId: string, worktreeId: string, base: string) =>
      host("githubCli", "pullRequestCompare", projectId, worktreeId, base),
    pullRequestOptions: (projectId: string) =>
      host("githubCli", "pullRequestOptions", projectId),
    // PR queries share a project-scoped prefix so invalidating
    // pullRequestsForProject reaches every open worktreePullRequest.
    pullRequestsAll: () => host("githubCli", "pullRequests"),
    pullRequestsForProject: (projectId: string) =>
      host("githubCli", "pullRequests", projectId),
    worktreePullRequest: (projectId: string, branch: string) =>
      host("githubCli", "pullRequests", projectId, PR_BRANCH_SCOPE, branch),
    pullRequestCandidates: (projectId: string) =>
      host("githubCli", "pullRequests", projectId, "candidates"),

    fsListDirectory: (path: string) => host("fs", "listDirectory", path),
    fsIsGitRepo: (path: string) => host("fs", "isGitRepo", path),

    // `ruleIgnored` is another verdict on the same folder, so it keys
    // apart from the carry-over picker's.
    carryOverListing: (
      projectId: string,
      relative: string,
      ruleIgnored = false,
    ) => host("carryOver", "listing", projectId, relative, ruleIgnored),
    carryOverStats: (projectId: string, paths: string[]) =>
      host("carryOver", "stats", projectId, paths),
    worktreeIncludeStatus: (projectId: string | null) =>
      host("worktreeIncludeStatus", projectId),
    relocationPlan: (
      projectId: string,
      layout: string,
      customPath: string | null,
      onProjectDrive: boolean,
    ) => host("relocationPlan", projectId, layout, customPath, onProjectDrive),

    // Host-scoped: the payload (RuntimeInfoSchema) is
    // a set of per-host facts served by the host-scoped runtime contract.
    runtimeInfo: () => host("runtime", "info"),

    // Host-scoped: a mirror's thread of events, keyed by the local
    // worktree like the host keeps it. (The mirror list itself is the
    // host's view, hooks/remote/useMirrors.ts.)
    mirrorHistory: (worktreeId: string) => host("mirrorHistory", worktreeId),

    ...queryKeys,
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

// The "state on this device moved, refetch what you're showing" sweep,
// for every device's externalChange broadcast (lib/hostWatch.ts, with
// the pinging device's id). Deliberately broad within its scope (the
// host debounces the signal and only active queries actually
// refetch), but some domains sit it out:
//
// - githubCli for scope AND cost: a disk change says nothing about
//   GitHub, and refetching PR lists here turns every ping into a burst
//   of gh network calls.
// - worktreeHygiene / worktreeDiskUsage for cost: both cache for 60s (a
//   sweep is several git calls or a directory walk per worktree) and
//   invalidation ignores staleTime. Focus, mount and the removal flow
//   still cover them.
// - runtime: static per-host facts. No git-state change touches them.
// - fs: a git-state ping says nothing about a directory listing.
const externalChangeExempt = new Set([
  // CLI links and rc hooks are not forest state, so a git-state ping
  // never re-asks.
  "cli",
  "cliShell",
  // The agents' hooks files, likewise: and an agent's turn changes
  // forest state on every prompt.
  "agents",
  // A full doctor run spawns git and gh on the host: it re-runs on
  // demand, never on a ping.
  "doctor",
  "fs",
  "githubCli",
  // Re-read on its own beat while on screen.
  "mirrorHistory",
  "runtime",
  "worktreeHygiene",
  "worktreeDiskUsage",
]);

// Whether a key takes part in the state-moved sweeps below: everything
// but the exempt domains.
function externalChangeAllows(queryKey: readonly unknown[]): boolean {
  return !externalChangeExempt.has(String(queryKeyDomain(queryKey)));
}

// The project-id slot of a project-scoped host key, derived from a
// sample built key like the PR matcher below, so the slot follows the
// builders if the prefix ever grows instead of silently drifting.
const projectIdIndex = queryKeysFor("d").shigomoriConfig("p").indexOf("p");
function hostKeyProjectId(queryKey: readonly unknown[]): unknown {
  return queryKey[0] === HOST_SCOPE ? queryKey[projectIdIndex] : undefined;
}

// The EXTERNAL-CHANGE sweep, scoped to one device. Host-scoped keys
// invalidate only when bound to THIS device id: a remote device's
// queries cache under its own id in the same host families, so a
// device-blind sweep would invalidate a peer's worktrees on a purely
// local change (and vice versa). Client-scoped keys are this app
// instance's, which no device's state moving touches. The exemptions
// above are the whole point of this entry: "state on that device
// moved" says nothing about GitHub or hygiene, so those sit the ping
// out. See invalidateDeviceSession for the sibling that must NOT sit
// them out.
export function invalidateHostDevice(
  queryClient: QueryClient,
  deviceId: string,
): void {
  refreshQueries(queryClient, {
    predicate: (query) => {
      if (hostKeyDeviceId(query.queryKey) !== deviceId) return false;
      return externalChangeAllows(query.queryKey);
    },
  });
}

// The queries a worktree owns on a device, for cancelling or dropping
// them together when it goes: every host key of that device that
// names the worktree id anywhere. Scoped by device, since worktree ids
// are path hashes that can collide across the owner's machines.
export function worktreeQueriesOn(
  deviceId: string,
  worktreeId: string,
): (query: { queryKey: readonly unknown[] }) => boolean {
  return (query) =>
    hostKeyDeviceId(query.queryKey) === deviceId &&
    query.queryKey.includes(worktreeId);
}

// The PROJECT-SCOPED sweep, for git:projectChanged: one project's git
// state moved on that device (a commit, a checkout, a ref written by
// any tool), so only the host keys carrying that project id refetch,
// under the same domain exemptions as the device-wide sweep. The
// git-state builders put the project id right after the domain, which
// is what hostKeyProjectId reads. Keys shaped otherwise (a client key,
// a whole-host key, the githubCli and carryOver sub-trees, neither of
// which is git state) carry no project id there and are left alone.
export function invalidateHostProject(
  queryClient: QueryClient,
  deviceId: string,
  projectId: string,
): void {
  refreshQueries(queryClient, {
    predicate: (query) => {
      if (hostKeyDeviceId(query.queryKey) !== deviceId) return false;
      if (hostKeyProjectId(query.queryKey) !== projectId) return false;
      return externalChangeAllows(query.queryKey);
    },
  });
}

// The SESSION-LANDED sweep: a device's data wire just came up, so
// everything host-scoped for it is fetchable now and none of it was a
// moment ago. Same device-id scoping as invalidateHostDevice and
// deliberately NO domain exemption, because the exempt list is tuned
// for "that host's git state moved" and is exactly wrong here: every
// query of the device fails with "no direct connection" until the
// keeper lands, the exempt domains included, so exempting them would
// leave those broken. Client-scoped keys are left alone in the other
// direction: they belong to this app instance, never to the peer, so a
// peer's session says nothing about them.
export function invalidateDeviceSession(
  queryClient: QueryClient,
  deviceId: string,
): void {
  // Not refreshQueries: it runs once per landing, and a read out then
  // is one failing toward its retry's backoff, so it is restarted.
  void queryClient.invalidateQueries({
    predicate: (query) => hostKeyDeviceId(query.queryKey) === deviceId,
  });
}

// Everything cached from one peer, gone: what a peer whose sharing
// switch went off shared is not kept around to show.
export function removeDeviceCache(
  queryClient: QueryClient,
  deviceId: string,
): void {
  queryClient.removeQueries({
    predicate: (query) => hostKeyDeviceId(query.queryKey) === deviceId,
  });
}

// Matchers live beside the builders they mirror and share their segment
// constants: a predicate that indexes a key by hand silently stops
// matching the moment a segment moves, and nothing fails loudly.
// Deriving length and scope position from a sample built key keeps the
// match exact (a projectId literally named "branch" can't slip in) and
// immune to the builder growing at either end.
const sampleWorktreePullRequestKey = queryKeysFor("d").worktreePullRequest(
  "p",
  "b",
);
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
