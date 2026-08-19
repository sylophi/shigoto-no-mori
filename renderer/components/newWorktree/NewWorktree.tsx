import { useEffect, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { Input } from "@/components/ui/input";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { usePickedWorktreeName } from "@/hooks/worktrees/usePickedWorktreeName";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useBranches } from "@/hooks/git/useBranches";
import { usePullRequestCandidates } from "@/hooks/githubCli/usePullRequestCandidates";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  useCreateWorktree,
  useCreateWorktreeFromPullRequest,
} from "@/hooks/worktrees/useWorktreeMutations";
import { tildify } from "@/lib/projectPaths";
import {
  PULL_REQUEST_SOURCE_UNAVAILABLE_TEXT,
  pullRequestBlockedBy,
  pullRequestFolderName,
} from "@/lib/pullRequest";
import {
  sanitizeBranchForPath,
  sanitizeBranchName,
  sanitizeWorktreeNameInput,
} from "@shared/branches";
import {
  isRealBranch,
  type CreateWorktreeResult,
  type PullRequestCandidate,
  type Worktree,
} from "@shared/schemas";
import { ModeToggle, type Mode } from "./ModeToggle";
import { PullRequestSource } from "./PullRequestPicker";

const route = getRouteApi("/projects/$projectId/new");

// What the destination line leads with, per mode.
const MODE_DEST_LEAD: Record<Mode, string> = {
  "branch-from": "A new branch created off the source. Checked out into",
  checkout: "Check out the source branch into",
  "pull-request": "Check out the pull request's head into",
};

// Where a PR checkout's folder name comes from. "pr" is the numbered
// name, "branch" is the PR's head ref, "custom" hands the field over.
type PrFolderSource = "pr" | "branch" | "custom";

// Branch leads: it's what `prFolderFrom` starts on, and a control whose
// default sits in the middle reads as if something was already changed.
const PR_FOLDER_OPTIONS = [
  {
    value: "branch",
    label: "Branch",
    title: "Name the folder after the PR's head branch",
  },
  { value: "pr", label: "PR", title: "Name the folder after the PR number" },
  { value: "custom", label: "Custom", title: "Type your own folder name" },
] as const satisfies readonly SegmentedOption<PrFolderSource>[];

// The source the form opens on. Gives way to "branch-from" when the
// pull request source turns out to be unavailable here.
const DEFAULT_MODE: Mode = "pull-request";

const TEXT_INPUT_CLASS = "w-full px-3 py-2 font-mono text-sm";

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- each field is set independently with no inter-field business logic
export function NewWorktree() {
  const { projectId } = route.useParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: defaultBranch } = useDefaultBranch(projectId);
  const { data: pickedName } = usePickedWorktreeName(projectId);
  const { data: worktrees = [] } = useWorktrees(projectId);
  const { data: branches } = useBranches(projectId);
  const project = projects.find((p) => p.id === projectId);
  // git refuses to check out a branch that's already a HEAD elsewhere.
  // Keyed by branch so the PR picker can name the worktree holding it,
  // not just grey the row out.
  const worktreeByBranch = new Map<string, Worktree>(
    worktrees.filter((w) => isRealBranch(w.branch)).map((w) => [w.branch, w]),
  );
  const occupiedBranches = [...worktreeByBranch.keys()];
  // null until the user picks a source, same as the seeded fields below.
  const [modeInput, setModeInput] = useState<Mode | null>(null);
  // Which source to open on, latched from the first availability verdict
  // we hear. Deriving it from the live query instead would let a later
  // refetch that can't reach GitHub move someone out of the pull request
  // source -- PR already picked -- and into a submittable branch-from
  // form they never asked for.
  const [defaultMode, setDefaultMode] = useState<Mode | null>(null);
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
  const base = baseInput ?? defaultBranch ?? "";
  const [worktreeName, setWorktreeName] = useState("");
  const [useBranchAsFolder, setUseBranchAsFolder] = useState(true);
  const [selectedPr, setSelectedPr] = useState<PullRequestCandidate | null>(
    null,
  );
  const [prFolderFrom, setPrFolderFrom] = useState<"pr" | "branch">("branch");
  const candidates = usePullRequestCandidates(projectId, prMode);
  const verdict = candidates.data;
  useEffect(() => {
    if (defaultMode !== null || !verdict) return;
    setDefaultMode(
      verdict.status === "unavailable" ? "branch-from" : DEFAULT_MODE,
    );
  }, [defaultMode, verdict]);
  const create = useCreateWorktree();
  const createFromPr = useCreateWorktreeFromPullRequest();

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  // Only the "unavailable" verdict is worth greying the option over, and
  // only once we've heard it -- while the query is in flight or errored
  // the mode stays offered. Never greyed while it's the selected mode,
  // so the user can't get stuck on a segment they can't click off of.
  const prUnavailable =
    candidates.data?.status === "unavailable"
      ? PULL_REQUEST_SOURCE_UNAVAILABLE_TEXT[candidates.data.reason]
      : undefined;

  // The picker hides occupied branches, but free-text "Use as ref" can
  // still smuggle one in — block submit and surface why.
  const baseOccupied = mode === "checkout" && occupiedBranches.includes(base);

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
  // be unreachable — the trailing `-` would be trimmed before the `2`).
  const folderSource = {
    "branch-from": branchName,
    checkout: base,
    "pull-request": !selectedPr
      ? ""
      : prFolderFrom === "branch"
        ? selectedPr.headRefName
        : pullRequestFolderName(selectedPr),
  }[mode];
  const folderName = sanitizeBranchForPath(
    useBranchAsFolder ? folderSource : worktreeName,
  );
  // Case-insensitive: NTFS and default APFS treat "Feature" and
  // "feature" as the same directory (matches the main-side check).
  const folderTaken =
    folderName.length > 0 &&
    worktrees.some((w) => w.name.toLowerCase() === folderName.toLowerCase());

  // A non-empty source that sanitizes to nothing (reserved words like
  // root/primary, dot names, DOS device names) would otherwise leave
  // the form silently unsubmittable: blank folder field, disabled
  // Create, and no branch to blame.
  const folderSourceRaw = useBranchAsFolder ? folderSource : worktreeName;
  const folderUnusable = folderSourceRaw.length > 0 && folderName.length === 0;

  const sourceReady = prMode
    ? selectedPr !== null && !prHeadOccupied
    : base.length > 0 &&
      (mode === "checkout" || branchName.length > 0) &&
      !branchTaken &&
      !baseOccupied;

  const canSubmit = sourceReady && folderName.length > 0 && !folderTaken;

  const onCreated = ({ worktree }: CreateWorktreeResult) => {
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId: worktree.projectId, worktreeId: worktree.id },
    });
  };

  const handleCreate = () => {
    if (prMode) {
      if (!selectedPr) return;
      createFromPr.mutate(
        {
          projectId: project.id,
          worktreeName: folderName,
          number: selectedPr.number,
        },
        { onSuccess: onCreated },
      );
      return;
    }
    create.mutate(
      mode === "checkout"
        ? {
            projectId: project.id,
            worktreeName: folderName,
            base,
            checkout: true,
          }
        : {
            projectId: project.id,
            worktreeName: folderName,
            branchName,
            base: base || undefined,
          },
      { onSuccess: onCreated },
    );
  };

  const busy = create.isPending || createFromPr.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit && !busy) {
      handleCreate();
    }
  };

  // Scoped to the active mode: a mutation keeps its last error, so the
  // other mode's stale failure would otherwise sit on top of this one.
  const errorMessage =
    (prMode ? createFromPr.error : create.error)?.message ?? null;
  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";
  const destPath = `${root}/worktrees/${project.name}/${folderName || "…"}`;
  const destLead = MODE_DEST_LEAD[mode];
  const destTrail =
    mode === "checkout"
      ? ". Branches already checked out in another worktree are hidden."
      : ".";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">New worktree</h1>
        </div>
      </header>

      <form
        className="min-h-0 flex-1 overflow-y-auto p-6"
        onSubmit={handleSubmit}
      >
        <div className="flex max-w-xl flex-col gap-7">
          {/* First, and outside the sections it governs: the pull request
            mode hides the source field, and a toggle that moves out from
            under the cursor as it's clicked is worse than the gap. The
            wrapper keeps the track hugging its options -- a bare flex
            child would stretch to the form's width. */}
          <div>
            <ModeToggle
              mode={mode}
              onChange={setModeInput}
              disabled={busy}
              pullRequestUnavailable={prMode ? undefined : prUnavailable}
            />
          </div>

          {!prMode && (
            <div className="space-y-2">
              <label
                htmlFor="branch-base"
                className="block text-sm font-medium"
              >
                Source
              </label>
              <BranchCombobox
                id="branch-base"
                projectId={projectId}
                value={base}
                onChange={setBaseInput}
                placeholder={defaultBranch ?? "main"}
                disabled={busy || !defaultBranch}
                excludeBranches={
                  mode === "checkout" ? occupiedBranches : undefined
                }
                pinnedBranch={defaultBranch}
              />
              {baseOccupied && (
                <p className="text-xs text-destructive">
                  <span className="font-mono">{base}</span> is already checked
                  out in another worktree.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            {prMode ? (
              <PullRequestSource
                query={candidates}
                unavailableText={prUnavailable}
                selected={selectedPr}
                onSelect={setSelectedPr}
                worktreeByBranch={worktreeByBranch}
                disabled={busy}
              />
            ) : (
              <>
                <label
                  htmlFor="branch-name"
                  className="block text-sm font-medium"
                >
                  Branch name
                </label>
                <Input
                  id="branch-name"
                  type="text"
                  value={mode === "checkout" ? base : branchName}
                  onChange={(e) =>
                    setBranchNameInput(sanitizeBranchName(e.target.value))
                  }
                  placeholder="feat/new-thing"
                  disabled={busy || mode === "checkout"}
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- focused subpage
                  autoFocus
                  className={TEXT_INPUT_CLASS}
                />
                {branchTaken && (
                  <p className="text-xs text-destructive">
                    A branch named{" "}
                    <span className="font-mono">{branchName}</span> already
                    exists in this project.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label
                htmlFor="worktree-name"
                className="block text-sm font-medium"
              >
                Worktree folder
              </label>
              {prMode ? (
                <SegmentedControl
                  aria-label="Worktree folder name source"
                  value={useBranchAsFolder ? prFolderFrom : "custom"}
                  onChange={(next) => {
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
                  options={PR_FOLDER_OPTIONS}
                  disabled={busy}
                  // The row is baseline-aligned for the label and the old
                  // checkbox; a bordered track wants its own centering.
                  className="self-center"
                  optionClassName="px-2 py-0.5 text-[11px]"
                />
              ) : (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    checked={useBranchAsFolder}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!next) {
                        // Seed the editable field with whatever was just shown,
                        // so toggling off doesn't blow away the user's context.
                        setWorktreeName(folderName);
                      }
                      setUseBranchAsFolder(next);
                    }}
                    disabled={busy}
                    className="size-3.5 shrink-0 accent-primary disabled:cursor-not-allowed"
                  />
                  Use {mode === "checkout" ? "source" : "branch"} name
                </label>
              )}
            </div>
            <Input
              id="worktree-name"
              type="text"
              value={useBranchAsFolder ? folderName : worktreeName}
              onChange={(e) =>
                setWorktreeName(sanitizeWorktreeNameInput(e.target.value))
              }
              placeholder={pickedName ?? "huggy-salamander"}
              disabled={busy || useBranchAsFolder}
              className={TEXT_INPUT_CLASS}
            />
            {folderTaken && (
              <p className="text-xs text-destructive">
                A worktree folder named{" "}
                <span className="font-mono">{folderName}</span> already exists
                in this project.
              </p>
            )}
            {folderUnusable && (
              <p className="text-xs text-destructive">
                <span className="font-mono">{folderSourceRaw}</span> can't be
                used as a folder name (root, primary, and dot names are
                reserved). Pick a different folder name.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {destLead}{" "}
              <span className="font-mono text-foreground/80 select-text">
                {destPath}
              </span>
              {destTrail}
            </p>
          </div>

          {errorMessage && <ErrorBanner>{errorMessage}</ErrorBanner>}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: "/" })}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || busy} size="sm">
              {busy ? "Creating…" : "Create worktree"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
