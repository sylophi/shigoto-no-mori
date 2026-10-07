import { queryOptions, useQuery } from "@tanstack/react-query";
import type { CarryOverCandidate } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  resolveForestScope,
  type HostForestScope,
} from "@/hooks/worktrees/useWorktrees";
import { queryKeysFor } from "@/lib/queryKeys";

// One folder of a project, unioned across the primary and every
// worktree on one device (host/lib/worktrees/carryOver.ts). Scope rule
// as worktreesQueryOptions: a peer's listing caches under its own
// device id, and a device with no session never fetches. Shared by the
// carry-over picker below and the leave-out preset's picker, which
// fans it out to every device holding the repo (useRepoListing) and
// asks for the mirror's verdict on folders (`ruleIgnored`, see
// CarryOverListingPayloadSchema).
export function carryOverListingQueryOptions(
  projectId: string,
  relative: string,
  scope: HostForestScope = {},
  { ruleIgnored = false }: { ruleIgnored?: boolean } = {},
) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<readonly CarryOverCandidate[]>({
    queryKey: queryKeysFor(deviceId).carryOverListing(
      projectId,
      relative,
      ruleIgnored,
    ),
    queryFn: () => {
      if (!api) return [];
      return api.projects.carryOverListing({
        projectId,
        relative,
        ...(ruleIgnored && { ruleIgnored }),
      });
    },
    enabled: api !== undefined && deviceId !== "",
    // Each fetch walks every checkout's ignored tree on the host. Dampen
    // the global refetch-on-focus so Cmd-Tabbing while the picker is open
    // doesn't re-walk them, same as useWorktreeIncludeStatus.
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read folder" },
  });
}

// The carry-over picker's view of one folder on the scope's device.
export function useCarryOverListing(projectId: string, relative: string) {
  return useQuery(
    carryOverListingQueryOptions(projectId, relative, useHostScope()),
  );
}
