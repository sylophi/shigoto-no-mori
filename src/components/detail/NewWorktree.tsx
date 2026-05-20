import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ErrorBanner } from "@/components/ui/error-banner";
import { cn } from "@/lib/utils";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { usePickedWorktreeName } from "@/hooks/usePickedWorktreeName";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useCreateWorktree, useWorktrees } from "@/hooks/useWorktrees";
import { tildify } from "@/lib/projectPaths";
import { newWorktreeRoute } from "@/router";
import { sanitizeBranchName } from "@shared/branches";
import { isRealBranch } from "@shared/schemas";

type Mode = "branch-from" | "checkout";

export function NewWorktree() {
  const { projectId } = newWorktreeRoute.useParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: defaultBranch } = useDefaultBranch(projectId);
  const { data: pickedName } = usePickedWorktreeName(projectId);
  const { data: worktrees = [] } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  // git refuses to check out a branch that's already a HEAD elsewhere.
  const occupiedBranches = worktrees
    .filter((w) => isRealBranch(w.branch))
    .map((w) => w.branch);
  const [mode, setMode] = useState<Mode>("branch-from");
  const [branchName, setBranchName] = useState("");
  const [base, setBase] = useState("");
  const baseSeeded = useRef(false);
  const branchSeeded = useRef(false);
  const create = useCreateWorktree();

  useEffect(() => {
    if (defaultBranch && !baseSeeded.current) {
      setBase(defaultBranch);
      baseSeeded.current = true;
    }
  }, [defaultBranch]);

  useEffect(() => {
    if (pickedName && !branchSeeded.current) {
      setBranchName(pickedName);
      branchSeeded.current = true;
    }
  }, [pickedName]);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  // The picker hides occupied branches, but free-text "Use as ref" can
  // still smuggle one in — block submit and surface why.
  const baseOccupied = mode === "checkout" && occupiedBranches.includes(base);

  const canSubmit =
    base.length > 0 &&
    (mode === "checkout" || branchName.length > 0) &&
    !baseOccupied;

  const handleCreate = () => {
    create.mutate(
      mode === "checkout"
        ? {
            projectId: project.id,
            worktreeName: pickedName || undefined,
            base,
            checkout: true,
          }
        : {
            projectId: project.id,
            worktreeName: pickedName || undefined,
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
  const destPath = `${root}/worktrees/${project.name}/${pickedName ?? "…"}`;
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
        className="flex max-w-xl flex-col gap-7 px-6 py-6"
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
            onChange={setBase}
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
          <input
            id="branch-name"
            type="text"
            value={mode === "checkout" ? base : branchName}
            onChange={(e) => setBranchName(sanitizeBranchName(e.target.value))}
            placeholder="feat/new-thing"
            disabled={busy || mode === "checkout"}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focused subpage
            autoFocus
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
          />
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

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
}) {
  const options: { value: Mode; label: string }[] = [
    { value: "branch-from", label: "Branch from source" },
    { value: "checkout", label: "Check out source" },
  ];
  return (
    <div className="inline-flex rounded-md border border-input p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          className={cn(
            "rounded-[5px] px-3 py-1 text-xs transition-colors",
            mode === opt.value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
