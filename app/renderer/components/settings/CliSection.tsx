import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";
import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shigomori/contracts/modules/cli";
import {
  CliSectionView,
  ShellIntegrationView,
} from "@shigomori/ui/views/settings/CliSectionView.tsx";
import { PeerReadError, peerStaleTime } from "./peerReads";

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
    queryFn: ({ signal }) => api.run(api.cli.status(), { signal }),
    staleTime: peerStaleTime(remote),
    meta: gatedHostReadMeta(remote, "Couldn't check the CLI install"),
  });

  const applyStatus = (next: CliStatus) => {
    queryClient.setQueryData(keys.cli(), next);
  };
  const install = useMutation({
    mutationFn: (payload: { force: boolean }) =>
      api.run(api.cli.install(payload)),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't install the CLI" },
  });
  const uninstall = useMutation({
    mutationFn: () => api.run(api.cli.uninstall()),
    onSuccess: (next) => {
      applyStatus(next);
      // CLI uninstall sweeps the shell hooks too.
      void queryClient.invalidateQueries({ queryKey: keys.cliShell() });
    },
    meta: { errorTitle: "Couldn't uninstall the CLI" },
  });

  if (!status) {
    return (
      <PeerReadError
        error={error}
        what="the CLI install"
        heading="Command line tool"
      />
    );
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

// Shell integration's block (ShellIntegrationView), its rc-file
// mechanics the CLI's own (`sm shell ...`).
function ShellIntegrationBlock({ name }: { name: string }) {
  const { api, keys, remote } = useHostScope();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const { data: status, error } = useQuery<ShellIntegrationStatus>({
    queryKey: keys.cliShell(),
    queryFn: ({ signal }) => api.run(api.cli.shellStatus(), { signal }),
    staleTime: peerStaleTime(remote),
    meta: gatedHostReadMeta(remote, "Couldn't check shell integration"),
  });

  const applyStatus = (next: ShellIntegrationStatus) => {
    queryClient.setQueryData(keys.cliShell(), next);
  };
  const enable = useMutation({
    mutationFn: () => api.run(api.cli.shellInstall()),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't enable shell integration" },
  });
  const remove = useMutation({
    mutationFn: () => api.run(api.cli.shellUninstall()),
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
