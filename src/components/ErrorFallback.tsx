import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorFallbackProps {
  error: Error;
  scope: "app" | "view";
  action: { label: string; onClick: () => void };
}

export function ErrorFallback({ error, scope, action }: ErrorFallbackProps) {
  const isApp = scope === "app";
  const copy = () => {
    void navigator.clipboard?.writeText(
      `${error.message}\n\n${error.stack ?? ""}`,
    );
  };

  return (
    <div
      className={cn(
        "flex items-center justify-center",
        isApp ? "h-dvh bg-background p-6 text-foreground" : "h-full p-8",
      )}
    >
      <div className={cn("w-full space-y-4", isApp ? "max-w-md" : "max-w-sm")}>
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-3.5" />
          <h2 className="text-sm font-medium">
            {isApp ? "App crashed" : "View crashed"}
          </h2>
        </div>
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap text-muted-foreground select-text">
          {error.message}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            Copy error
          </Button>
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
