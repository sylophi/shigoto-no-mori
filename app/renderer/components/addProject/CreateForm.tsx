import * as Schema from "effect/Schema";
import { useState } from "react";
import { FolderPlus } from "lucide-react";
import {
  CreateProjectPayloadSchema,
  type GhUnavailableReason,
} from "@shigomori/contracts/schemas";
import {
  useGithubOwners,
  usePublishRepo,
} from "@/hooks/githubCli/useGithubPublish";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { useCreateProject } from "@/hooks/projects/useProjects";
import { notifyError } from "@/lib/toast";
import { CreateFormView, type Visibility } from "./CreateFormView";
import { ProgressPanelView } from "./DialogPartsView";
import { useNewCheckout } from "./useNewCheckout";

const isFolderName = Schema.is(CreateProjectPayloadSchema.fields.name);

// Starts a new repository on the scoped device, publishes it to GitHub
// if asked, and opens it as a project.
// react-doctor-disable-next-line react-doctor/no-giant-component -- one form and its two stages, with the parts that stand alone in DialogParts and useNewCheckout
export function CreateForm({
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
  const nameValid = isFolderName(trimmed);
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
      <ProgressPanelView
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
    <CreateFormView
      name={name}
      onName={setName}
      inputRef={checkout.inputRef}
      canCreate={nameValid}
      onCreate={() => void createAndOpen()}
      dest={checkout.dest}
      onChangeParent={checkout.openPicker}
      ghUnavailable={ghUnavailable}
      publish={publish}
      onPublish={(next) => setPublishOff(!next)}
      owners={owners}
      owner={owner}
      onOwner={setPickedOwner}
      visibility={visibility}
      onVisibility={setVisibility}
      terrierOptIn={checkout.terrierOptIn}
      picker={checkout.picker}
    />
  );
}

// Why the scoped device's gh can't publish, "loading" while that isn't
// known yet, or null when it can.
function useGhUnavailable(): GhUnavailableReason | "loading" | null {
  const { data: readiness } = useGithubCliReadiness();
  return readiness === undefined ? "loading" : readiness.unavailable;
}
