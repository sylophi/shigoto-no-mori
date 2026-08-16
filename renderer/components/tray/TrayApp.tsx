import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { DoubutsuProvider } from "@/hooks/ui/useDoubutsu";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import { TrayPanel } from "./TrayPanel";

// A crashed popover has no room for the full ErrorFallback (stack,
// actions) and no window chrome to escape from, so it says what happened
// and offers the one recovery that fits: reload the document.
function TrayErrorFallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="p-1.5">
      <div
        data-slot="tray-panel"
        className="flex flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      >
        <p className="text-xs text-destructive">Menu bar list crashed.</p>
        <p className="line-clamp-2 text-[10px] text-muted-foreground">
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="self-start text-[10px] text-muted-foreground underline hover:text-foreground"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

// Root of the menu bar popover. Deliberately thinner than App.tsx: no
// router (there is nowhere to navigate), no overlays, no toaster, no
// query-invalidation watchers -- those belong to the window that owns
// the work. Theme and doubutsu are here because the popover has to look
// like the app in all four appearance combinations.
export function TrayApp() {
  return (
    <ThemeProvider syncNativeChrome={false}>
      <DoubutsuProvider>
        <ErrorBoundary FallbackComponent={TrayErrorFallback}>
          <TrayPanel />
        </ErrorBoundary>
      </DoubutsuProvider>
    </ThemeProvider>
  );
}
