// The fold of a sidebar project no checkout on this machine belongs
// to, the peer-only twin of useCollapsedProjects. A local project's
// fold lives with its host. These have no host here, so the window
// keeps them in the client config, by group key. Absence == expanded,
// the same default the local list has.
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";

export function useCollapsedRemoteProjects(): readonly string[] {
  const { data: config } = useClientConfig();
  return config?.collapsedRemoteProjects ?? [];
}

// A per-key toggle computed off the doc as it is at the click, so two
// quick toggles compose instead of the second replaying a stale list.
export function useToggleCollapsedRemoteProject() {
  return useClientConfigPatch<string>((groupKey, current) => {
    const list = current?.collapsedRemoteProjects ?? [];
    return {
      collapsedRemoteProjects: list.includes(groupKey)
        ? list.filter((key) => key !== groupKey)
        : [...list, groupKey],
    };
  }, "Couldn't save collapsed projects");
}
