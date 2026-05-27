import { useState } from "react";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { useCreateBranch } from "@/hooks/git/useBranches";
import { sanitizeBranchName } from "@shared/branches";

export function NewBranchForm({
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
          onChange={(e) => setName(sanitizeBranchName(e.target.value))}
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
