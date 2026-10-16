// The band over the page while this machine's host is away, and after
// the shell started it again.
import { HostBandView } from "../views/hostBand/HostBandView.tsx";

export function HostBandScene() {
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden bg-background p-6 text-foreground">
      <HostBandView state={{ kind: "away" }} />
      <HostBandView
        state={{ kind: "restarted", reason: { kind: "silent", seconds: 30 } }}
      />
      <HostBandView
        state={{ kind: "restarted", reason: { kind: "exited", code: 1 } }}
      />
    </div>
  );
}
