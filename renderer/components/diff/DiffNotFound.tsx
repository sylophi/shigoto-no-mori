import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";

export function DiffNotFound({
  onBack,
  message,
  action,
}: {
  onBack: () => void;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label="Back" />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        {message}
        {action && (
          <Button variant="outline" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
