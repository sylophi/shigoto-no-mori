import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useCreateWorktree } from "@/hooks/useWorktrees";
import { tildify } from "@/lib/projectPaths";
import { newWorktreeRoute } from "@/router";

type Mode = "branch-from" | "checkout";

export function NewWorktree() {
  const { projectId } = newWorktreeRoute.useParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: defaultBranch } = useDefaultBranch(projectId);
  const project = projects.find((p) => p.id === projectId);
  const [mode, setMode] = useState<Mode>("branch-from");
  const [branchName, setBranchName] = useState("");
  const [base, setBase] = useState("");
  const baseSeeded = useRef(false);
  const create = useCreateWorktree();

  useEffect(() => {
    if (defaultBranch && !baseSeeded.current) {
      setBase(defaultBranch);
      baseSeeded.current = true;
    }
  }, [defaultBranch]);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Project not found.
      </div>
    );
  }

  const canSubmit =
    base.length > 0 && (mode === "checkout" || branchName.length > 0);

  const handleCreate = () => {
    create.mutate(
      mode === "checkout"
        ? { projectId: project.id, base, checkout: true }
        : { projectId: project.id, branchName, base: base || undefined },
      {
        onSuccess: (worktree) => {
          void navigate({
            to: "/projects/$projectId/worktrees/$worktreeName",
            params: {
              projectId: worktree.projectId,
              worktreeName: worktree.name,
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
          />
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
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="feat/new-thing"
            disabled={busy || mode === "checkout"}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focused subpage
            autoFocus
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {mode === "branch-from" ? (
            <p className="text-xs text-muted-foreground">
              A new branch created off the source. Checked out into a folder
              under{" "}
              <span className="font-mono">
                {root}/worktrees/{project.name}/
              </span>
              .
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Check out the source branch directly in a new folder. Fails if
              the branch is already checked out in another worktree.
            </p>
          )}
        </div>

        {errorMessage && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!canSubmit || busy} size="sm">
            {busy ? "Creating…" : "Create worktree"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: "/" })}
            disabled={busy}
          >
            Cancel
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
