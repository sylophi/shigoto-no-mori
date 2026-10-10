import { useState } from "react";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { useCreateBranch } from "@/hooks/git/useBranches";
import { NewBranchFormView } from "@shigomori/ui/views/manageBranches/NewBranchFormView.tsx";

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

  const submit = () => {
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
    <NewBranchFormView
      name={name}
      onName={setName}
      basePicker={
        <BranchCombobox
          id="new-branch-base"
          projectId={projectId}
          value={base}
          onChange={setBase}
          placeholder={defaultBase ?? "main"}
        />
      }
      canSubmit={canSubmit}
      pending={create.isPending}
      onSubmit={submit}
      onCancel={onDone}
    />
  );
}
