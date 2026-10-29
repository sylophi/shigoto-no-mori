import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { cloneFolderName, stripUrlCredentials } from "@shared/cloneUrl";
import {
  cloneUrlOf,
  isCloneableRemote,
  isGithubShorthand,
  normalizeRemoteUrl,
} from "@shigomori/contracts/predicates/remoteUrl";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { useGithubRepos } from "@/hooks/githubCli/useGithubRepos";
import { useCloneProgress } from "@/hooks/projects/useCloneProgress";
import { useCloneProject } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { rankByScore } from "@shigomori/ui/lib/fuzzyMatch.ts";
import { CloneFormView } from "@shigomori/ui/views/addProject/CloneFormView.tsx";
import { ProgressPanelView } from "@shigomori/ui/views/addProject/DialogPartsView.tsx";
import { cloneProgressBar } from "@shigomori/ui/views/addProject/cloneProgress.ts";
import { useNewCheckout } from "./useNewCheckout";

// Clones a remote onto the scoped device and opens it as a project, or
// stops on Cancel and leaves nothing behind.
// Where the device's gh is signed in, its GitHub repositories are
// listed under the input to pick from, narrowed by what is typed.
// react-doctor-disable-next-line react-doctor/no-giant-component -- one form and its progress stage, with the parts that stand alone in DialogParts and useNewCheckout
export function CloneForm({
  url,
  setUrl,
  addToTerrier,
  setAddToTerrier,
  setWorking,
  onClose,
}: {
  // Owned by the dialog, so a pasted URL is as good on the next device.
  url: string;
  setUrl: (value: string) => void;
  addToTerrier: boolean;
  setAddToTerrier: (value: boolean) => void;
  setWorking: (working: boolean) => void;
  onClose: () => void;
}) {
  const scope = useHostScope();
  const cloneProject = useCloneProject();
  // The clone in flight, by what interrupts it.
  const [cloning, setCloning] = useState<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Held open while it clones. Undone on unmount too, or a view gone
  // midway would leave the dialog held.
  const busy = cloning !== null;
  useEffect(() => {
    if (!busy) return;
    setWorking(true);
    return () => setWorking(false);
  }, [busy, setWorking]);
  const { data: readiness } = useGithubCliReadiness();
  const { data: repos = [] } = useGithubRepos(readiness?.unavailable === null);
  // A URL names its repository whole, so the list steps aside for it.
  const typed = url.trim();
  const matches = isCloneableRemote(typed)
    ? []
    : rankByScore(typed, repos, (repo) => repo);
  // An `owner/repo` typed out leads the list unless the list holds it,
  // so ↩ clones what was typed and not a longer name that matched it.
  const typedRow =
    isGithubShorthand(typed) &&
    !repos.some((repo) => repo.toLowerCase() === typed.toLowerCase());
  const rows = typedRow ? [typed, ...matches] : matches;
  const [highlighted, setHighlighted] = useState("");
  // What ↩ clones: the highlighted row, or what was typed.
  const source = rows.find((row) => row === highlighted) ?? url;
  const name = cloneFolderName(source);
  const checkout = useNewCheckout({
    folder: name ?? "",
    pickerTitle: "Clone into",
    addToTerrier,
    setAddToTerrier,
    onClose,
  });
  // The repository as repo identity spells it (host/owner/repo): the
  // credentials and scheme of a pasted URL are noise here.
  const repo = normalizeRemoteUrl(cloneUrlOf(source)) ?? source.trim();
  const progress = useCloneProgress(cloning && checkout.parent, name);

  const cloneAndOpen = async () => {
    if (name === null) return;
    const controller = new AbortController();
    setCloning(controller);
    // useCloneProject surfaces the error via toast, and answers a
    // cancel with null. No try here: React Compiler bails on the early
    // return one would need.
    const project = await cloneProject
      .mutateAsync({
        input: {
          // A peer clones with its own credentials. Ones pasted in with
          // the URL stay on this device, the rule pickCloneUrl keeps.
          url: scope.remote ? stripUrlCredentials(source) : source.trim(),
          parentDir: checkout.parent,
          name,
          terrier: checkout.terrier,
        },
        signal: controller.signal,
      })
      .catch(() => null);
    if (project === null) {
      // Back to the URL, still in the input, to fix it or the folder.
      setCloning(null);
      setCancelling(false);
      return;
    }
    checkout.finish(project, "Cloned");
  };

  if (cloning) {
    return (
      <ProgressPanelView
        icon={
          <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
        }
        title={repo}
        status={`Cloning${checkout.onDevice}…`}
        dest={checkout.dest}
        progress={progress ? cloneProgressBar(progress) : undefined}
        cancelling={cancelling}
        onCancel={() => {
          setCancelling(true);
          cloning.abort();
        }}
      />
    );
  }

  return (
    <CloneFormView
      url={url}
      onUrl={setUrl}
      inputRef={checkout.inputRef}
      highlighted={highlighted}
      onHighlight={setHighlighted}
      rows={rows}
      typedRow={typedRow}
      repo={repo}
      canClone={name !== null}
      onClone={() => void cloneAndOpen()}
      dest={checkout.dest}
      onChangeParent={checkout.openPicker}
      terrierOptIn={checkout.terrierOptIn}
      picker={checkout.picker}
    />
  );
}
