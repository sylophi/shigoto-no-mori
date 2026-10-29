// Whether a repo's settings are kept the same on every device holding
// it (host lib/sharedSettings/projectSettings.ts). A shared setting by
// repo identity, so the switch is one for all of them.
import { useMutation } from "@tanstack/react-query";
import { projectSettingsSync } from "@shigomori/contracts/sharedSettings";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useSharedSettingsView } from "./useSharedSettings";

export function useProjectSettingsSync(
  identity: string | null | undefined,
): boolean {
  return (
    useSharedSettingsView(
      (doc) =>
        identity != null && projectSettingsSync(doc, identity) !== undefined,
    ) === true
  );
}

// Switched at the device holding the project, whose settings the others
// take when it turns on.
export function useSetProjectSettingsSync(projectId: string) {
  const { api } = useHostScope();
  const mutation = useMutation({
    mutationFn: (on: boolean) =>
      api.run(api.shigomori.syncSettings({ projectId, on })),
    meta: { errorTitle: "Couldn't switch the settings sync" },
  });
  return (on: boolean) => mutation.mutate(on);
}
