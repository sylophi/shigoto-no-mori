// The folders the list of projects gathers projects into, inside their
// owner. A shared setting by the project's group key (projectGroupKey),
// like the pins, so a repo filed on one device is filed on all of them.
// A folder is only its name: it lasts while a project is in it.
import { useMutation } from "@tanstack/react-query";
import {
  projectFolders,
  sharedSettingKeys,
} from "@shigomori/contracts/sharedSettings";
import { writeSharedSetting } from "@/lib/remote/sharedSettingsSync";
import { useApi } from "@/lib/runtime/pageApi";
import { useRegistry } from "@/lib/runtime/viewHooks";
import { useSharedSettingsView } from "./useSharedSettings";

export function useProjectFolders(): ReadonlyMap<string, string> {
  return new Map(useSharedSettingsView(projectFolders));
}

// Files the projects into `folder`, or takes them out of theirs (null).
// Several at once for a folder's rename.
export function useSetProjectFolder() {
  const api = useApi();
  const registry = useRegistry();
  const mutation = useMutation({
    mutationFn: (move: {
      groupKeys: readonly string[];
      folder: string | null;
    }) =>
      Promise.all(
        move.groupKeys.map((groupKey) =>
          writeSharedSetting(
            api,
            registry,
            sharedSettingKeys.projectFolder(groupKey),
            move.folder,
          ),
        ),
      ),
    meta: { errorTitle: "Couldn't save the folder" },
  });
  return (groupKeys: readonly string[], folder: string | null) =>
    mutation.mutate({ groupKeys, folder });
}
