import { BackButton } from "../../primitives/back-button.tsx";
import { Button } from "../../primitives/button.tsx";
import { cn } from "../../lib/utils.ts";
import { PAGE_HEADER_PADDING } from "./PageHeaderView.tsx";

export function SubPageNotFoundView({
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
      <header className={cn("border-b border-border", PAGE_HEADER_PADDING)}>
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
