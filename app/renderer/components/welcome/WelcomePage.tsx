import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { CliStatus } from "@shigomori/contracts/modules/cli";
import { tildify } from "@shigomori/contracts/projectPaths";
import { OnboardingView } from "@shigomori/ui/views/steps/OnboardingView.tsx";
import type { StepState } from "@shigomori/ui/views/steps/StepsPageView.tsx";
import { AddExistingForm } from "@/components/addProject/AddExistingForm";
import { useOpenAddedProject } from "@/components/addProject/useOpenAddedProject";
import { useSignInStep } from "@/components/steps/useSignInStep";
import { useMarkWelcomed } from "@/hooks/config/useWelcomed";
import { useAddProject, useProjects } from "@/hooks/projects/useProjects";
import { LocalHostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useTerrierReadiness } from "@/hooks/terrier/useTerrierReadiness";

// A fresh install's first run (the /welcome route), in place of the
// app: the sign-in, the terminal `sm` linked in, and the first project.
// Signing in is up to the person; adding the project opens the app on
// it (AddExistingForm), signed in or not. An install that already has
// projects is past it, and goes on to the app.
export function WelcomePage() {
  return (
    <LocalHostScope>
      <Welcome />
    </LocalHostScope>
  );
}

function Welcome() {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const markWelcomed = useMarkWelcomed();
  const { signIn, run } = useSignInStep(true);
  const cli = useCliStep();
  const terrier = useTerrierPick(projects);
  const [query, setQuery] = useState("~/");
  const [addToTerrier, setAddToTerrier] = useState(true);
  const escapeRef = useRef<(() => void) | null>(null);

  const hasProject = projects !== undefined && projects.length > 0;
  // The first list the page reads: a project there already means the
  // first run is behind this install. The page draws meanwhile, since a
  // fresh install is what opens on it. One added here opens itself.
  const [firstList, setFirstList] = useState<"waiting" | "empty" | "some">(
    "waiting",
  );
  if (firstList === "waiting" && projects !== undefined) {
    setFirstList(hasProject ? "some" : "empty");
  }
  useEffect(() => {
    if (hasProject) markWelcomed();
  }, [hasProject, markWelcomed]);
  useEffect(() => {
    if (firstList === "some") void navigate({ to: "/", replace: true });
  }, [firstList, navigate]);

  if (firstList === "some") return null;
  return (
    <OnboardingView
      signIn={signIn}
      onSignIn={run}
      cli={cli.step}
      onReplaceCli={cli.replace}
      project={{ state: hasProject ? "done" : "waiting" }}
      picker={
        <AddExistingForm
          query={query}
          setQuery={setQuery}
          addToTerrier={addToTerrier}
          setAddToTerrier={setAddToTerrier}
          onClose={() => {}}
          escapeRef={escapeRef}
        />
      }
      repos={terrier.repos}
      addingRepo={terrier.picked}
      onPickRepo={terrier.pick}
    />
  );
}

// The terminal `sm` linked into the shell as Settings links it, without
// asking where nothing is in the way. A link another program owns waits
// on the person's Replace.
function useCliStep(): {
  readonly step: {
    readonly state: StepState;
    readonly foreign: ReadonlyArray<string>;
  };
  readonly replace: () => void;
} {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  const { data: status } = useQuery<CliStatus>({
    queryKey: keys.cli(),
    queryFn: () => api.cli.status(),
  });
  const install = useMutation({
    mutationFn: (force: boolean) => api.cli.install({ force }),
    onSuccess: (next) => queryClient.setQueryData(keys.cli(), next),
    meta: { errorTitle: "Couldn't install the CLI" },
  });
  const asked = useRef(false);
  const owed = status?.state === "missing" || status?.state === "stale";
  useEffect(() => {
    if (!owed || asked.current) return;
    asked.current = true;
    install.mutate(false);
  }, [owed, install]);

  const foreign =
    status?.state === "foreign"
      ? status.foreignPaths?.length
        ? status.foreignPaths
        : [status.linkPath]
      : [];
  const state: StepState = install.isPending
    ? "running"
    : install.isError
      ? "stuck"
      : status?.state === "installed"
        ? "done"
        : owed
          ? "running"
          : "waiting";
  return { step: { state, foreign }, replace: () => install.mutate(true) };
}

// terrier's repos beside the picker, whatever this device's terrier
// switch says, those not added already. A pick turns the switch on,
// which lists them all as projects, adds the one picked as the picker
// adds one, and opens it.
function useTerrierPick(
  projects: ReadonlyArray<{ id: string; path: string }> | undefined,
) {
  const { api, keys } = useHostScope();
  const { data: readiness } = useTerrierReadiness();
  const readable = readiness?.readable === true;
  const { data: listed = [] } = useQuery({
    queryKey: [...keys.terrierReadiness(), "repos"],
    queryFn: () => api.terrier.repos(),
    enabled: readable,
  });
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const addProject = useAddProject();
  const openAdded = useOpenAddedProject();
  const pick = useMutation({
    mutationFn: async (path: string) => {
      await api.globalConfig.writeDeviceSettings({ patch: { terrier: true } });
      const project = await addProject.mutateAsync({ path, terrier: false });
      await openAdded(project.id);
    },
    meta: { errorTitle: "Couldn't add the project" },
  });
  const taken = new Set(projects?.map((project) => project.path));
  return {
    repos: listed
      .filter((repo) => !taken.has(repo.path))
      .map((repo) => ({ name: repo.name, path: tildify(repo.path, home) })),
    picked: pick.isPending ? (pick.variables ?? null) : null,
    pick: (shown: string) => {
      const repo = listed.find((it) => tildify(it.path, home) === shown);
      if (repo !== undefined) pick.mutate(repo.path);
    },
  };
}
