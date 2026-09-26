// The sidebar's folded projects, by group key (projectGroupKey in
// components/sidebar/buildSidebarRows.ts), local and peer-only alike.
// A preference of the window, kept in its client config like the
// sidebar view: a peer has no say in how this machine's tree is
// folded, and a hostless client folds the same way. Absence ==
// expanded, and an empty list is stored as nothing.
import type { ClientConfig } from "@shared/schemas";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";

const NONE: ReadonlySet<string> = new Set();

function withToggledKey(
  current: ClientConfig | undefined,
  groupKey: string,
): Pick<ClientConfig, "collapsedProjects"> {
  const list = current?.collapsedProjects ?? [];
  const next = list.includes(groupKey)
    ? list.filter((key) => key !== groupKey)
    : [...list, groupKey];
  return { collapsedProjects: next.length > 0 ? next : undefined };
}

export function useCollapsedProjects(): {
  collapsedKeys: ReadonlySet<string>;
  toggleCollapsed: (groupKey: string) => void;
} {
  const { data: config } = useClientConfig();
  // A per-key toggle computed off the doc as it is at the click, so two
  // quick toggles compose instead of the second replaying a stale list.
  const { mutate } = useClientConfigPatch<string>(
    (groupKey, current) => withToggledKey(current, groupKey),
    "Couldn't save collapsed projects",
  );
  const list = config?.collapsedProjects;
  return {
    collapsedKeys: list === undefined ? NONE : new Set(list),
    toggleCollapsed: mutate,
  };
}
