import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";

export function MergedPrimaryBranchBoxView({
  target,
  armed,
  pending,
  onClick,
}: {
  // The local name of the primary branch it switches to.
  target: string;
  armed: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex justify-end">
      <ConfirmDestructiveButton
        armed={armed}
        pending={pending}
        pendingLabel={`Switching to ${target}…`}
        idleLabel={`Delete branch and switch to ${target}`}
        onClick={onClick}
      />
    </div>
  );
}
