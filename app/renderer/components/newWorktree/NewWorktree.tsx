import { sanitizeBranchForPath } from "@shigomori/contracts/predicates/worktreeDirName";
import { useEffect, useState } from "react";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { VillagerMovingIn } from "./VillagerMovingIn";

import { useWorktreeBaseLabel } from "@/hooks/config/useWorktreeBaseLabel";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { usePickedWorktreeName } from "@/hooks/worktrees/usePickedWorktreeName";
import { useBranches } from "@/hooks/git/useBranches";
import { usePullRequestCandidates } from "@/hooks/githubCli/usePullRequestCandidates";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  useCreateWorktree,
  useCreateWorktreeFromPullRequest,
} from "@/hooks/worktrees/useWorktreeMutations";
import {
  PULL_REQUEST_SOURCE_UNAVAILABLE_TEXT,
  pullRequestBlockedBy,
  pullRequestFolderName,
} from "@/lib/pullRequest";
import { localBranchOf } from "@shared/git/branches";
import {
  isRealBranch,
  type CreateWorktreeResult,
  type Project,
  type PullRequestCandidate,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { PullRequestSourceView } from "./PullRequestPickerView";
import {
  NewWorktreeBodyView,
  NewWorktreeFormView,
  type NewWorktreeMode,
} from "./NewWorktreeView";

// The source the form opens on. Gives way to "branch-from" when the
// pull request source turns out to be unavailable here.
const DEFAULT_MODE: NewWorktreeMode = "pull-request";

// The page: which project, and on which machine. The frame every
// project page shares picks the device (a tab per device holding the
// repo), and the form beneath is the same whichever device wins,
// mounted under that device's host scope and handed THAT device's
// project id -- every hook in it keys off project.id plus scope, so the
// branch list, the folder collision check and the create all follow
// the pick with no remote-awareness of their own.
export function NewWorktree() {
  return (
    <ProjectDevicePage title="New worktree">
      {(scoped, tab) => (
        <NewWorktreeBodyView>
          <NewWorktreeForm
            project={scoped}
            // Undefined with no choice of device: the form keeps the
            // copy it has always had rather than naming a machine
            // nobody chose.
            deviceLabel={tab?.label}
          />
        </NewWorktreeBodyView>
      )}
    </ProjectDevicePage>
  );
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- each field is set independently with no inter-field business logic
function NewWorktreeForm({
  project,
  deviceLabel,
}: {
  // The project ON THE SCOPED DEVICE: the local one locally, the
  // identity-matched peer project when the form is pointed elsewhere.
  project: Project;
  // The device to name in the destination line and on the create
  // button. Undefined when the page offers no choice.
  deviceLabel: string | undefined;
}) {
  const goBack = useGoBack();
  // Scope-aware: under a peer's provider its toWorktree lands on that
  // device's detail page, where the new worktree lives.
  const { toWorktree } = useWorktreeNav();
  // Where the worktree lands on the scoped device.
  const destRoot = useWorktreeBaseLabel(project);
  const { data: defaultBranch } = useDefaultBranch(project.id);
  const { data: pickedName } = usePickedWorktreeName(project.id);
  const { data: worktrees = [] } = useWorktrees(project.id);
  const { data: branches } = useBranches(project.id);
  // git refuses to check out a branch that's already a HEAD elsewhere.
  // Keyed by branch so the PR picker can name the worktree holding it,
  // not just grey the row out.
  const worktreeByBranch = new Map<string, Worktree>(
    worktrees.filter((w) => isRealBranch(w.branch)).map((w) => [w.branch, w]),
  );
  // The worktree holding the branch a checkout of `ref` would land on,
  // so `origin/main` is just as blocked as `main` while the primary
  // holds it. Mirrors pullRequestBlockedBy so the warning can name the
  // holder.
  const localRefs = new Set(branches?.local ?? []);
  const remoteRefs = new Set(branches?.remote ?? []);
  const worktreeHolding = (ref: string): Worktree | undefined =>
    worktreeByBranch.get(localBranchOf(ref, remoteRefs));
  // What checkout mode leaves out of the picker: refs held by a
  // worktree, and remote refs shadowed by a local branch (picking
  // `origin/feat` would land on local `feat` anyway, the same rule as
  // the branch switcher).
  const hiddenInCheckout = [...localRefs, ...remoteRefs].filter(
    (ref) =>
      worktreeHolding(ref) !== undefined ||
      (remoteRefs.has(ref) && localRefs.has(localBranchOf(ref, remoteRefs))),
  );
  // null until the user picks a source, same as the seeded fields below.
  const [modeInput, setModeInput] = useState<NewWorktreeMode | null>(null);
  // Which source to open on, latched from the first availability verdict
  // we hear. Deriving it from the live query instead would let a later
  // refetch that can't reach GitHub move someone out of the pull request
  // source (PR already picked) and into a submittable branch-from
  // form they never asked for.
  const [defaultMode, setDefaultMode] = useState<NewWorktreeMode | null>(null);
  // gh runs on the scoped device, so a pull request checks out there
  // like any other source. Its readiness verdict (below) says whether
  // that device can offer it.
  const mode = modeInput ?? defaultMode ?? DEFAULT_MODE;
  const prMode = mode === "pull-request";
  // The branch name and base are seeded from async reads (the picked
  // animal name and the resolved default branch), so state holds only
  // what the user typed; null means "not edited yet" and falls through
  // to the seed. This keeps the form interactive the moment it mounts
  // (the seeds fill in when they land) without a seed-once effect, and
  // an explicit edit is never clobbered by a late-arriving seed.
  const [branchNameInput, setBranchNameInput] = useState<string | null>(null);
  const [baseInput, setBaseInput] = useState<string | null>(null);
  const branchName = branchNameInput ?? pickedName ?? "";
  // Checkout mode can't open on the default branch while a worktree
  // holds it (the usual layout: primary on main), so the source starts
  // empty there rather than on an error the user didn't cause.
  const baseSeed =
    mode === "checkout" && defaultBranch && worktreeHolding(defaultBranch)
      ? ""
      : (defaultBranch ?? "");
  const base = baseInput ?? baseSeed;
  // The branch the worktree actually lands on: checkout mode resolves a
  // remote ref to its local branch, which is what the read-only branch
  // field and the folder name should show.
  const checkoutBranch = localBranchOf(base, remoteRefs);
  const [worktreeName, setWorktreeName] = useState("");
  const [useBranchAsFolder, setUseBranchAsFolder] = useState(true);
  const [selectedPr, setSelectedPr] = useState<PullRequestCandidate | null>(
    null,
  );
  const [prFolderFrom, setPrFolderFrom] = useState<"pr" | "branch">("branch");
  const [cloneFiles, setCloneFiles] = useState(true);
  const candidates = usePullRequestCandidates(project.id, prMode);
  const verdict = candidates.data;
  useEffect(() => {
    if (defaultMode !== null || !verdict) return;
    setDefaultMode(
      verdict.status === "unavailable" ? "branch-from" : DEFAULT_MODE,
    );
  }, [defaultMode, verdict]);
  const create = useCreateWorktree();
  const createFromPr = useCreateWorktreeFromPullRequest();

  // Only the "unavailable" verdict is worth greying the option over, and
  // only once we've heard it. While the query is in flight or errored
  // the mode stays offered. Never greyed while it's the selected mode,
  // so the user can't get stuck on a segment they can't click off of.
  const prUnavailable =
    candidates.data?.status === "unavailable"
      ? PULL_REQUEST_SOURCE_UNAVAILABLE_TEXT[candidates.data.reason]
      : undefined;
  // Set when the pull request source can't be offered (no gh, no GitHub
  // remote). Greys that option out and doubles as its tooltip. The form
  // prints the same line under the control.
  const prOptionOff = prMode ? undefined : prUnavailable;

  // The picker hides occupied branches, but free-text "Use as ref" can
  // still smuggle one in, so block submit and surface why.
  const baseHolder = mode === "checkout" ? worktreeHolding(base) : undefined;

  // `git worktree add -b` refuses an existing branch name. Catch it
  // up-front so the form mirrors the source/folder collision warnings.
  const branchTaken =
    mode === "branch-from" &&
    branchName.length > 0 &&
    (branches?.local.includes(branchName) ?? false);

  // A PR checkout blocks the same way an occupied base does in checkout
  // mode. Same rule that greys the picker's rows out, so the submit gate
  // and the list can't disagree.
  const prHeadOccupied =
    selectedPr !== null &&
    pullRequestBlockedBy(selectedPr, worktreeByBranch) !== undefined;

  // Raw `worktreeName` is held separately from the sanitized `folderName`
  // so trailing dashes survive mid-typing (otherwise `my-folder-2` would
  // be unreachable: the trailing `-` would be trimmed before the `2`).
  const folderSource = {
    "branch-from": branchName,
    checkout: checkoutBranch,
    "pull-request": !selectedPr
      ? ""
      : prFolderFrom === "branch"
        ? selectedPr.headRefName
        : pullRequestFolderName(selectedPr),
  }[mode];
  const folderSourceRaw = useBranchAsFolder ? folderSource : worktreeName;
  const folderName = sanitizeBranchForPath(folderSourceRaw);
  // Case-insensitive: NTFS and default APFS treat "Feature" and
  // "feature" as the same directory (matches the main-side check).
  const folderTaken =
    folderName.length > 0 &&
    worktrees.some((w) => w.name.toLowerCase() === folderName.toLowerCase());

  // Checkout mode waits for the branch list: the occupancy gate reads
  // it, and submitting before it lands would let the CLI find the
  // collision instead.
  const sourceReady = prMode
    ? selectedPr !== null && !prHeadOccupied
    : base.length > 0 &&
      (mode === "checkout" ? branches !== undefined : branchName.length > 0) &&
      !branchTaken &&
      baseHolder === undefined;

  const canSubmit = sourceReady && folderName.length > 0 && !folderTaken;

  const onCreated = ({ worktree }: CreateWorktreeResult) => {
    toWorktree(worktree.projectId, worktree.id);
  };

  const handleCreate = () => {
    const target = {
      projectId: project.id,
      worktreeName: folderName,
      cloneFiles,
    };
    if (prMode) {
      if (!selectedPr) return;
      createFromPr.mutate(
        { ...target, number: selectedPr.number },
        { onSuccess: onCreated },
      );
      return;
    }
    create.mutate(
      mode === "checkout"
        ? { ...target, base, checkout: true }
        : { ...target, branchName, base: base || undefined },
      { onSuccess: onCreated },
    );
  };

  const busy = create.isPending || createFromPr.isPending;

  // Scoped to the active mode: a mutation keeps its last error, so the
  // other mode's stale failure would otherwise sit on top of this one.
  const errorMessage =
    (prMode ? createFromPr.error : create.error)?.message ?? null;
  const destName = folderName || "…";
  const destPath = destRoot ? `${destRoot}/${destName}` : destName;

  return (
    <NewWorktreeFormView
      mode={mode}
      onMode={setModeInput}
      prOptionOff={prOptionOff}
      busy={busy}
      sourcePicker={
        <BranchCombobox
          id="branch-base"
          projectId={project.id}
          value={base}
          onChange={setBaseInput}
          placeholder={
            mode === "checkout" ? "Pick a branch" : (defaultBranch ?? "main")
          }
          disabled={busy || !defaultBranch}
          excludeBranches={mode === "checkout" ? hiddenInCheckout : undefined}
          pinnedBranch={defaultBranch}
        />
      }
      deviceLabel={deviceLabel}
      base={base}
      checkoutBranch={checkoutBranch}
      baseHolder={baseHolder?.name}
      prSource={
        <PullRequestSourceView
          query={candidates}
          unavailableText={prUnavailable}
          selected={selectedPr}
          onSelect={setSelectedPr}
          worktreeByBranch={worktreeByBranch}
          disabled={busy}
        />
      }
      branchName={branchName}
      onBranchName={setBranchNameInput}
      branchTaken={branchTaken}
      useBranchAsFolder={useBranchAsFolder}
      prFolderFrom={prFolderFrom}
      onPrFolder={(next) => {
        if (next === "custom") {
          // Seed the editable field with whatever was just shown,
          // so switching doesn't blow away the user's context.
          setWorktreeName(folderName);
          setUseBranchAsFolder(false);
          return;
        }
        setPrFolderFrom(next);
        setUseBranchAsFolder(true);
      }}
      onUseSourceName={(next) => {
        if (!next) {
          // Seed the editable field with whatever was just shown,
          // so toggling off doesn't blow away the user's context.
          setWorktreeName(folderName);
        }
        setUseBranchAsFolder(next);
      }}
      worktreeName={worktreeName}
      onWorktreeName={setWorktreeName}
      folderName={folderName}
      folderPlaceholder={pickedName ?? "huggy-salamander"}
      folderTaken={folderTaken}
      folderSourceRaw={folderSourceRaw}
      destPath={destPath}
      villager={<VillagerMovingIn folderName={folderName} />}
      cloneFiles={cloneFiles}
      onCloneFiles={setCloneFiles}
      errorMessage={errorMessage}
      canSubmit={canSubmit}
      onSubmit={() => {
        if (canSubmit && !busy) handleCreate();
      }}
      onCancel={goBack}
    />
  );
}
