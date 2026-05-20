import { useState } from "react";
import {
  Check,
  ExternalLink,
  House,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SectionHeading } from "@/components/ui/section-heading";
import { cn } from "@/lib/utils";
import {
  useBranches,
  useCreateBranch,
  useDeleteBranch,
  useRenameAnyBranch,
} from "@/hooks/useBranches";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useProjects } from "@/hooks/useProjects";
import { useWorktrees } from "@/hooks/useWorktrees";
import { manageBranchesRoute } from "@/router";
import { isRealBranch, type Worktree } from "@shared/schemas";

export function ManageBranches() {
  const { projectId } = manageBranchesRoute.useParams();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { data: branches } = useBranches(projectId);
  const { data: worktrees = [] } = useWorktrees(projectId);
  const { data: defaultBranch } = useDefaultBranch(projectId);
  const [creating, setCreating] = useState(false);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const worktreeByBranch = new Map<string, Worktree>();
  for (const w of worktrees) {
    if (isRealBranch(w.branch)) worktreeByBranch.set(w.branch, w);
  }

  const locals = branches?.local ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Manage branches
          </h1>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <SectionHeading>Local branches</SectionHeading>
              {!creating && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setCreating(true)}
                >
                  <Plus />
                  New branch
                </Button>
              )}
            </div>

            {creating && (
              <NewBranchForm
                projectId={projectId}
                defaultBase={defaultBranch ?? null}
                onDone={() => setCreating(false)}
              />
            )}

            {locals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No local branches yet.
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-border">
                {locals.map((name, idx) => (
                  <BranchRow
                    key={name}
                    projectId={projectId}
                    name={name}
                    worktree={worktreeByBranch.get(name)}
                    isLast={idx === locals.length - 1}
                  />
                ))}
              </div>
            )}
          </section>

          {(branches?.remote ?? []).length > 0 && (
            <section className="space-y-3">
              <SectionHeading>Remote-tracking branches</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Read-only references. Use one as a source when creating a new
                local branch.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(branches?.remote ?? []).map((name) => (
                  <span
                    key={name}
                    className="rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground select-text"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function NewBranchForm({
  projectId,
  defaultBase,
  onDone,
}: {
  projectId: string;
  defaultBase: string | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [base, setBase] = useState(defaultBase ?? "");
  const create = useCreateBranch();
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && base.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    create.mutate(
      { projectId, name: trimmed, base },
      {
        onSuccess: () => {
          setName("");
          onDone();
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
    >
      <div className="space-y-1.5">
        <label htmlFor="new-branch-name" className="block text-xs font-medium">
          Branch name
        </label>
        <input
          id="new-branch-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.replace(/ /g, "-"))}
          placeholder="feat/new-thing"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focused on opening form
          autoFocus
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="new-branch-base" className="block text-xs font-medium">
          Source
        </label>
        <BranchCombobox
          id="new-branch-base"
          projectId={projectId}
          value={base}
          onChange={setBase}
          placeholder={defaultBase ?? "main"}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="xs"
          disabled={!canSubmit || create.isPending}
        >
          {create.isPending ? "Creating…" : "Create"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onDone}
          disabled={create.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BranchRow({
  projectId,
  name,
  worktree,
  isLast,
}: {
  projectId: string;
  name: string;
  worktree: Worktree | undefined;
  isLast: boolean;
}) {
  const navigate = useNavigate();
  const rename = useRenameAnyBranch();
  const del = useDeleteBranch();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [needsForce, setNeedsForce] = useState(false);
  const checkedOut = !!worktree;

  const commitRename = () => {
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      setDraft(name);
      return;
    }
    rename.mutate(
      { projectId, oldName: name, newName: next },
      {
        onSuccess: () => setEditing(false),
        onError: () => {
          setEditing(false);
          setDraft(name);
        },
      },
    );
  };

  const handleDelete = () => {
    del.mutate(
      { projectId, name, force: false },
      {
        onError: () => setNeedsForce(true),
      },
    );
  };

  const handleForceDelete = () => {
    del.mutate(
      { projectId, name, force: true },
      { onSuccess: () => setNeedsForce(false) },
    );
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-3 py-2 text-sm",
        !isLast && "border-b border-border",
      )}
    >
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/ /g, "-"))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(name);
            }
          }}
          onBlur={commitRename}
          disabled={rename.isPending}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- inline edit
          autoFocus
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono select-text">
          {name}
        </span>
      )}

      {checkedOut && !editing && (
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/projects/$projectId/worktrees/$worktreeId",
              params: { projectId, worktreeId: worktree.id },
            })
          }
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`Checked out in ${worktree.name}`}
        >
          {worktree.isPrimary ? (
            <House className="size-3" />
          ) : worktree.isExternal ? (
            <ExternalLink className="size-3" />
          ) : null}
          <span className="truncate">{worktree.name}</span>
        </button>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {needsForce ? (
            <>
              <span className="px-2 text-xs text-destructive select-text">
                {del.error?.message ?? "Has unmerged commits."}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setNeedsForce(false);
                  del.reset();
                }}
                disabled={del.isPending}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleForceDelete}
                disabled={del.isPending}
              >
                <Trash2 />
                {del.isPending ? "Deleting…" : "Force delete"}
              </Button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Rename ${name}`}
                title="Rename"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={checkedOut || del.isPending}
                aria-label={`Delete ${name}`}
                title={
                  checkedOut
                    ? "Switch to a different branch in this worktree first"
                    : "Delete"
                }
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {editing && (
        <button
          type="button"
          onMouseDown={(e) => {
            // Prevent onBlur from firing before this click is processed.
            e.preventDefault();
            setEditing(false);
            setDraft(name);
          }}
          aria-label="Cancel rename"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {editing && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commitRename}
          aria-label="Save rename"
          disabled={rename.isPending}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Check className="size-3.5" />
        </button>
      )}
    </div>
  );
}
