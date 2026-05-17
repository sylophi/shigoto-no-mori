import type { FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";

export function AppErrorFallback({ error }: FallbackProps) {
  const err = error instanceof Error ? error : new Error(String(error));
  const copy = () => {
    void navigator.clipboard?.writeText(`${err.message}\n\n${err.stack ?? ""}`);
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1">
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            The app hit an unexpected error and can't recover on its own. Reload
            the window to start fresh.
          </p>
        </div>
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
          {err.message}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            Copy error
          </Button>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload window
          </Button>
        </div>
      </div>
    </div>
  );
}
