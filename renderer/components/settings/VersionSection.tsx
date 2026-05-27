import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useUpdater } from "@/hooks/system/useUpdater";
import { UpdaterStatusLine } from "./UpdaterStatusLine";

export function VersionSection() {
  const { state, check, install } = useUpdater();
  const kind = state?.kind ?? "idle";
  const ready = state?.kind === "ready" ? state : null;

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Version</SectionHeading>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="font-mono text-sm select-text">
            {__APP_VERSION__}{" "}
            <span className="text-muted-foreground">({__APP_COMMIT__})</span>
          </div>
          {ready ? (
            <Button
              size="sm"
              onClick={() => install.mutate()}
              disabled={install.isPending}
            >
              <RefreshCw />
              Restart to update to v{ready.version}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => check.mutate()}
              disabled={kind === "checking" || kind === "downloading"}
            >
              {kind === "checking" || kind === "downloading" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {kind === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
        <div className="-mt-1 block">
          <UpdaterStatusLine state={state} />
        </div>
      </div>
    </section>
  );
}
