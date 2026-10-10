import type { ReactNode } from "react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { sanitizeBranchName } from "@shared/git/branches";

export function NewBranchFormView({
  name,
  onName,
  basePicker,
  canSubmit,
  pending,
  onSubmit,
  onCancel,
}: {
  name: string;
  onName: (name: string) => void;
  // The branch it starts from (BranchCombobox).
  basePicker: ReactNode;
  canSubmit: boolean;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
    >
      <div className="space-y-1.5">
        <label htmlFor="new-branch-name" className="block text-xs font-medium">
          Branch name
        </label>
        <Input
          id="new-branch-name"
          type="text"
          value={name}
          onChange={(e) => onName(sanitizeBranchName(e.target.value))}
          placeholder="feat/new-thing"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focused on opening form
          autoFocus
          className="w-full px-3 py-1.5 font-mono text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="new-branch-base" className="block text-xs font-medium">
          Source
        </label>
        {basePicker}
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={!canSubmit || pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
