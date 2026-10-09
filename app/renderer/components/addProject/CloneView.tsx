import { useState } from "react";
import { Command } from "cmdk";
import { GitBranch } from "lucide-react";
import {
  cloneFolderName,
  cloneUrlOf,
  isCloneableRemote,
  isGithubShorthand,
  stripUrlCredentials,
} from "@shared/cloneUrl";
import { normalizeRemoteUrl } from "@shared/git/repoIdentity.mts";
import {
  ITEM_CLASS,
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "@/components/ui/cmdk-classes";
import { GithubMark } from "@/components/ui/svgs/github-mark";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { useGithubRepos } from "@/hooks/githubCli/useGithubRepos";
import { useCloneProject } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { rankByScore } from "@/lib/fuzzyMatch";
import { cn } from "@/lib/utils";
import {
  ActionInputRow,
  DestinationRow,
  FormFooter,
  ProgressPanel,
} from "./DialogParts";
import { useNewCheckout } from "./useNewCheckout";

// Clones a remote onto the scoped device and opens it as a project.
// Where the device's gh is signed in, its GitHub repositories are
// listed under the input to pick from, narrowed by what is typed.
// react-doctor-disable-next-line react-doctor/no-giant-component -- one form and its progress stage, with the parts that stand alone in DialogParts and useNewCheckout
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

  const cloneAndOpen = async () => {
    if (name === null) return;
    setCloning(true);
    // useCloneProject surfaces the error via toast. No try here: React
    // Compiler bails on the early return one would need.
    const project = await cloneProject
      .mutateAsync({
        // A peer clones with its own credentials. Ones pasted in with
        // the URL stay on this device, the rule pickCloneUrl keeps.
        url: scope.remote ? stripUrlCredentials(source) : source.trim(),
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
      {/* The Command holds the input and its list alone: around the
          rest, its keys would take ↩ from the buttons below. */}
      <Command
        label="Clone"
        loop
        shouldFilter={false}
        // Only a click or ↑↓ picks a row: a pointer passing over the
        // list on its way to the button would otherwise pick for it.
        disablePointerSelection
        value={highlighted}
        onValueChange={setHighlighted}
        className={MODAL_COMMAND_CLASS}
      >
        <ActionInputRow
          value={url}
          onChange={setUrl}
          placeholder="Git URL or GitHub owner/repo"
          inputRef={checkout.inputRef}
          icon={<GitBranch className="size-3.5" />}
          label="Clone"
          canSubmit={name !== null}
          onSubmit={() => void cloneAndOpen()}
          combobox
        />
        {rows.length > 0 && (
          <Command.List
            onMouseDown={keepFocusInInput}
            className="max-h-64 overflow-y-auto border-b border-border p-2"
          >
            {rows.map((row, index) => (
              <Command.Item
                key={row}
                value={row}
                className={cn(ITEM_CLASS, "hover:bg-accent/50")}
              >
                {typedRow && index === 0 ? (
                  <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
                ) : (
                  <GithubMark className="size-4 shrink-0 text-muted-foreground/80" />
                )}
                <SimpleTooltip whenTruncated lazy tip={row}>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {row}
                  </span>
                </SimpleTooltip>
              </Command.Item>
            ))}
          </Command.List>
        )}
      </Command>
      <div className="flex flex-col gap-3 p-4 text-sm">
        {rows.length === 0 && name !== null && (
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
