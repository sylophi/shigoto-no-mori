import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessageOf,
  isCommandRefusedError,
} from "@shigomori/contracts/errors";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";
import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shigomori/contracts/modules/cli";
import {
  CliSectionView,
  PeerReadErrorView,
  ShellIntegrationView,
} from "./CliSectionView";

// The CLI's install (CliSectionView) on whichever device the section
// is mounted for, so a peer's section installs on the peer. A peer
// refuses the status read without the command grant, and the section
// then renders nothing rather than toasting a permission state.
export function CliSection() {
  const { api, keys, remote } = useHostScope();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { data: status, error } = useQuery<CliStatus>({
    queryKey: keys.cli(),
    queryFn: () => api.cli.status(),
    staleTime: peerStaleTime(remote),
    meta: gatedHostReadMeta(remote, "Couldn't check the CLI install"),
  });

  const applyStatus = (next: CliStatus) => {
    queryClient.setQueryData(keys.cli(), next);
  };
  const install = useMutation({
    mutationFn: (payload: { force: boolean }) => api.cli.install(payload),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't install the CLI" },
  });
  const uninstall = useMutation({
    mutationFn: () => api.cli.uninstall(),
    onSuccess: (next) => {
      applyStatus(next);
      // CLI uninstall sweeps the shell hooks too.
      void queryClient.invalidateQueries({ queryKey: keys.cliShell() });
    },
    meta: { errorTitle: "Couldn't uninstall the CLI" },
  });

  if (!status) {
    return <PeerReadError error={error} what="the CLI install" heading />;
  }

  return (
    <CliSectionView
      status={status}
      home={runtime?.homedir ?? null}
      busy={install.isPending || uninstall.isPending}
      onInstall={(force) => install.mutate({ force })}
      onUninstall={() => uninstall.mutate()}
      shell={<ShellIntegrationBlock name={status.name} />}
    />
  );
}

// Each read on a peer is a round trip, and the shell one spawns the
// CLI there, for state that only these buttons and that machine's own
// terminal change. The mutations seed the cache from their replies and
// a landed session re-asks, so a peer's answer needs no focus refetch.
// This machine keeps the default: a terminal install shows on return.
function peerStaleTime(remote: boolean): number {
  return remote ? Number.POSITIVE_INFINITY : 0;
}

// A peer's failed read is silent in the toast layer (gatedHostReadMeta),
// so it is said here instead of the section just not being there. A
// refusal is the exception: that is the read-only state the page
// already explains. Locally the toast carries the error.
function PeerReadError({
  error,
  what,
  heading = false,
}: {
  error: unknown;
  what: string;
  heading?: boolean;
}) {
  const { remote } = useHostScope();
  if (!remote || !error || isCommandRefusedError(error)) return null;
  return (
    <PeerReadErrorView
      what={what}
      message={errorMessageOf(error)}
      heading={heading}
    />
  );
}

// Shell integration's block (ShellIntegrationView), its rc-file
// mechanics the CLI's own (`sm shell ...`).
function ShellIntegrationBlock({ name }: { name: string }) {
  const { api, keys, remote } = useHostScope();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const { data: status, error } = useQuery<ShellIntegrationStatus>({
    queryKey: keys.cliShell(),
    queryFn: () => api.cli.shellStatus(),
    staleTime: peerStaleTime(remote),
    meta: gatedHostReadMeta(remote, "Couldn't check shell integration"),
  });

  const applyStatus = (next: ShellIntegrationStatus) => {
    queryClient.setQueryData(keys.cliShell(), next);
  };
  const enable = useMutation({
    mutationFn: () => api.cli.shellInstall(),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't enable shell integration" },
  });
  const remove = useMutation({
    mutationFn: () => api.cli.shellUninstall(),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't remove shell integration" },
  });

  if (!status) {
    return <PeerReadError error={error} what="shell integration" />;
  }

  return (
    <ShellIntegrationView
      name={name}
      status={status}
      home={home}
      busy={enable.isPending || remove.isPending}
      onEnable={() => enable.mutate()}
      onRemove={() => remove.mutate()}
      changed={enable.isSuccess || remove.isSuccess}
    />
  );
}
