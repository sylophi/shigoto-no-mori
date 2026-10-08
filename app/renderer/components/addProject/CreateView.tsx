import { useState } from "react";
import { ChevronDown, FolderPlus } from "lucide-react";
import {
  CreateProjectPayloadSchema,
  type GhUnavailableReason,
} from "@shared/schemas";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { GithubMark } from "@/components/ui/svgs/github-mark";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useGithubOwners,
  usePublishRepo,
} from "@/hooks/githubCli/useGithubPublish";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { useCreateProject } from "@/hooks/projects/useProjects";
import { GH_UNAVAILABLE_TEXT } from "@/lib/pullRequest";
import { notifyError } from "@/lib/toast";
import {
  ActionInputRow,
  DestinationRow,
  FormFooter,
  ProgressPanel,
} from "./DialogParts";
import { useNewCheckout } from "./useNewCheckout";

type Visibility = "private" | "public";

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
] as const;

// Starts a new repository on the scoped device, publishes it to GitHub
// if asked, and opens it as a project.
// react-doctor-disable-next-line react-doctor/no-giant-component -- one form and its two stages, with the parts that stand alone in DialogParts and useNewCheckout
export function CreateView({
  name,
  setName,
  addToTerrier,
  setAddToTerrier,
  onClose,
}: {
  // Owned by the dialog, so it outlives a change of mode or device.
  name: string;
  setName: (value: string) => void;
  addToTerrier: boolean;
  setAddToTerrier: (value: boolean) => void;
  onClose: () => void;
}) {
  const createProject = useCreateProject();
  const publishRepo = usePublishRepo();
  const [stage, setStage] = useState<"form" | "creating" | "publishing">(
    "form",
  );
  const trimmed = name.trim();
  const nameValid =
    CreateProjectPayloadSchema.shape.name.safeParse(trimmed).success;
  const checkout = useNewCheckout({
    folder: trimmed,
    pickerTitle: "Create in",
    addToTerrier,
    setAddToTerrier,
    onClose,
  });

  // Publishing is on by default wherever the device's gh can do it, so
  // a repository that will live on GitHub is one keypress away.
  const ghUnavailable = useGhUnavailable();
  const [publishOff, setPublishOff] = useState(false);
  const publish = ghUnavailable === null && !publishOff;
  const [visibility, setVisibility] = useState<Visibility>("private");
  const { data: owners } = useGithubOwners(publish);
  // Undefined is gh's signed-in user, for an owner list that never came.
  const [pickedOwner, setPickedOwner] = useState<string | null>(null);
  const owner = pickedOwner ?? owners?.[0];

  const createAndOpen = async () => {
    if (!nameValid) return;
    setStage("creating");
    // useCreateProject surfaces the error via toast.
    const project = await createProject
      .mutateAsync({
        parentDir: checkout.parent,
        name: trimmed,
        terrier: checkout.terrier,
      })
      .catch(() => null);
    if (project === null) {
      setStage("form");
      return;
    }
    if (publish) {
      setStage("publishing");
      // The project is there either way, so a failed publish says so
      // and the flow still ends on it.
      await publishRepo
        .mutateAsync({ projectId: project.id, owner, visibility })
        .catch((error: unknown) =>
          notifyError(
            `Created ${project.name}, but couldn't publish it to GitHub`,
            error,
          ),
        );
    }
    checkout.finish(project, "Created");
  };

  if (stage !== "form") {
    return (
      <ProgressPanel
        icon={
          <FolderPlus className="size-4 shrink-0 text-muted-foreground/80" />
        }
        title={trimmed}
        status={
          stage === "creating"
            ? `Creating${checkout.onDevice}…`
            : "Publishing to GitHub…"
        }
        dest={checkout.dest}
      />
    );
  }

  return (
    <>
      <ActionInputRow
        value={name}
        onChange={setName}
        placeholder="Name of the new repository"
        inputRef={checkout.inputRef}
        icon={<FolderPlus className="size-3.5" />}
        label="Create"
        canSubmit={nameValid}
        onSubmit={() => void createAndOpen()}
      />
      <div className="flex flex-col gap-3 p-4 text-sm">
        <DestinationRow
          dest={checkout.dest}
          onChangeParent={checkout.openPicker}
        />
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
          <SimpleTooltip
            tip={
              ghUnavailable && ghUnavailable !== "loading"
                ? GH_UNAVAILABLE_TEXT[ghUnavailable]
                : undefined
            }
          >
            <label className="-mx-1 flex shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-1 select-none has-disabled:cursor-not-allowed has-disabled:opacity-50">
              <Checkbox
                checked={publish}
                disabled={ghUnavailable !== null}
                onCheckedChange={(next) => {
                  setPublishOff(!next);
                  checkout.inputRef.current?.focus();
                }}
              />
              <GithubMark className="size-4" />
              Publish to GitHub
            </label>
          </SimpleTooltip>
          {publish && (
            <div className="ml-auto flex items-center gap-2">
              {owners && owner && (
                <OwnerMenu
                  owners={owners}
                  owner={owner}
                  onChange={setPickedOwner}
                />
              )}
              <SegmentedControl
                value={visibility}
                onChange={setVisibility}
                options={VISIBILITY_OPTIONS}
                aria-label="Visibility"
              />
            </div>
          )}
        </div>
      </div>
      <FormFooter label="Create">{checkout.terrierOptIn}</FormFooter>
      {checkout.picker}
    </>
  );
}

// Why the scoped device's gh can't publish, "loading" while that isn't
// known yet, or null when it can.
function useGhUnavailable(): GhUnavailableReason | "loading" | null {
  const { data: readiness } = useGithubCliReadiness();
  return readiness === undefined ? "loading" : readiness.unavailable;
}

function OwnerMenu({
  owners,
  owner,
  onChange,
}: {
  owners: readonly string[];
  owner: string;
  onChange: (owner: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Owner"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <span className="max-w-40 truncate">{owner}</span>
        <ChevronDown aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
        <DropdownMenuRadioGroup
          value={owner}
          onValueChange={(value) => onChange(value as string)}
        >
          {owners.map((entry) => (
            <DropdownMenuRadioItem key={entry} value={entry}>
              {entry}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
