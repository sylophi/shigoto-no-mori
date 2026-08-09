import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { Input } from "@/components/ui/input";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { usePickedWorktreeName } from "@/hooks/worktrees/usePickedWorktreeName";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useBranches } from "@/hooks/git/useBranches";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useCreateWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { tildify } from "@/lib/projectPaths";
import {
  sanitizeBranchForPath,
  sanitizeBranchName,
  sanitizeWorktreeNameInput,
} from "@shared/branches";
import { isRealBranch } from "@shared/schemas";
import { ModeToggle, type Mode } from "./ModeToggle";

const route = getRouteApi("/projects/$projectId/new");

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
  const occupiedBranches = worktrees.reduce<string[]>((acc, w) => {
    if (isRealBranch(w.branch)) acc.push(w.branch);
    return acc;
  }, []);
  const [mode, setMode] = useState<Mode>("branch-from");
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
  const create = useCreateWorktree();

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  // The picker hides occupied branches, but free-text "Use as ref" can
  // still smuggle one in — block submit and surface why.
  const baseOccupied = mode === "checkout" && occupiedBranches.includes(base);

  // `git worktree add -b` refuses an existing branch name. Catch it
  // up-front so the form mirrors the source/folder collision warnings.
  const branchTaken =
    mode === "branch-from" &&
    branchName.length > 0 &&
    (branches?.local.includes(branchName) ?? false);

  // Raw `worktreeName` is held separately from the sanitized `folderName`
  // so trailing dashes survive mid-typing (otherwise `my-folder-2` would
  // be unreachable — the trailing `-` would be trimmed before the `2`).
  const folderSource = mode === "checkout" ? base : branchName;
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

  const canSubmit =
    base.length > 0 &&
    (mode === "checkout" || branchName.length > 0) &&
    folderName.length > 0 &&
    !folderTaken &&
    !branchTaken &&
    !baseOccupied;

  const handleCreate = () => {
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
      {
        onSuccess: ({ worktree }) => {
          void navigate({
            to: "/projects/$projectId/worktrees/$worktreeId",
            params: {
              projectId: worktree.projectId,
              worktreeId: worktree.id,
            },
          });
        },
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit && !create.isPending) {
      handleCreate();
    }
  };

  const busy = create.isPending;
  const errorMessage = create.error ? create.error.message : null;
  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";
  const destPath = `${root}/worktrees/${project.name}/${folderName || "…"}`;
  const destLead =
    mode === "branch-from"
      ? "A new branch created off the source. Checked out into"
      : "Check out the source branch into";
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
        className="flex max-w-xl flex-col gap-7 p-6"
        onSubmit={handleSubmit}
      >
        <div className="space-y-2">
          <label htmlFor="branch-base" className="block text-sm font-medium">
            Source
          </label>
          <BranchCombobox
            id="branch-base"
            projectId={projectId}
            value={base}
            onChange={setBaseInput}
            placeholder={defaultBranch ?? "main"}
            disabled={busy || !defaultBranch}
            excludeBranches={mode === "checkout" ? occupiedBranches : undefined}
          />
          {baseOccupied && (
            <p className="text-xs text-destructive">
              <span className="font-mono">{base}</span> is already checked out
              in another worktree.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <ModeToggle mode={mode} onChange={setMode} disabled={busy} />
          <label
            htmlFor="branch-name"
            className="block pt-2 text-sm font-medium"
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
              A branch named <span className="font-mono">{branchName}</span>{" "}
              already exists in this project.
            </p>
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
              <span className="font-mono">{folderName}</span> already exists in
              this project.
            </p>
          )}
          {folderUnusable && (
            <p className="text-xs text-destructive">
              <span className="font-mono">{folderSourceRaw}</span> can't be used
              as a folder name (root, primary, dot names, and Windows device
              names are reserved). Pick a different folder name.
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
      </form>
    </div>
  );
}
