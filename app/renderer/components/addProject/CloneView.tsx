import { useState } from "react";
import { GitBranch } from "lucide-react";
import { repoNameFromUrl, stripUrlCredentials } from "@shared/cloneUrl";
import { normalizeRemoteUrl } from "@shigomori/contracts/predicates/remoteUrl";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useCloneProject } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  ActionInputRow,
  DestinationRow,
  FormFooter,
  ProgressPanel,
} from "./DialogParts";
import { useNewCheckout } from "./useNewCheckout";

// Clones a remote onto the scoped device and opens it as a project.
export function CloneView({
  url,
  setUrl,
  addToTerrier,
  setAddToTerrier,
  onClose,
}: {
  // Owned by the dialog, so a pasted URL is as good on the next device.
  url: string;
  setUrl: (value: string) => void;
  addToTerrier: boolean;
  setAddToTerrier: (value: boolean) => void;
  onClose: () => void;
}) {
  const scope = useHostScope();
  const cloneProject = useCloneProject();
  const [cloning, setCloning] = useState(false);
  const name = repoNameFromUrl(url);
  const checkout = useNewCheckout({
    folder: name ?? "",
    pickerTitle: "Clone into",
    addToTerrier,
    setAddToTerrier,
    onClose,
  });
  // The remote as repo identity spells it (host/owner/repo): the
  // credentials and scheme of the pasted URL are noise here.
  const repo = normalizeRemoteUrl(url) ?? url.trim();

  const cloneAndOpen = async () => {
    if (name === null) return;
    setCloning(true);
    // useCloneProject surfaces the error via toast. No try here: React
    // Compiler bails on the early return one would need.
    const project = await cloneProject
      .mutateAsync({
        // A peer clones with its own credentials. Ones pasted in with
        // the URL stay on this device, the rule pickCloneUrl keeps.
        url: scope.remote ? stripUrlCredentials(url) : url.trim(),
        parentDir: checkout.parent,
        name,
        terrier: checkout.terrier,
      })
      .catch(() => null);
    if (project === null) {
      // Back to the URL, still in the input, to fix it or the folder.
      setCloning(false);
      return;
    }
    checkout.finish(project, "Cloned");
  };

  if (cloning) {
    return (
      <ProgressPanel
        icon={
          <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
        }
        title={repo}
        status={`Cloning${checkout.onDevice}…`}
        dest={checkout.dest}
      />
    );
  }

  return (
    <>
      <ActionInputRow
        value={url}
        onChange={setUrl}
        placeholder="Git URL to clone"
        inputRef={checkout.inputRef}
        icon={<GitBranch className="size-3.5" />}
        label="Clone"
        canSubmit={name !== null}
        onSubmit={() => void cloneAndOpen()}
      />
      <div className="flex flex-col gap-3 p-4 text-sm">
        {name !== null && (
          <div className="flex items-center gap-2.5">
            <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
            <SimpleTooltip whenTruncated tip={repo}>
              <span className="min-w-0 flex-1 truncate font-mono">{repo}</span>
            </SimpleTooltip>
          </div>
        )}
        <DestinationRow
          dest={checkout.dest}
          onChangeParent={checkout.openPicker}
        />
      </div>
      <FormFooter label="Clone">{checkout.terrierOptIn}</FormFooter>
      {checkout.picker}
    </>
  );
}
