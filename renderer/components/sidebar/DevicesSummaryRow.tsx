// The sidebar's quiet devices rail: one dot per machine on the account
// (this one included) and a "3 devices · 1 offline" line, sitting just
// above the footer. It is the tree's one connection summary — presence
// changes show here without a single row shouting — and clicking it
// opens the Devices page.
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";

export function DevicesSummaryRow() {
  const navigate = useNavigate();
  const remote = useRemoteDevices();
  if (remote.length === 0) return null;
  const views = remote.map((device) => deviceStatusView(device.status));
  const offline = views.filter((view) => !view.reachable).length;
  const total = remote.length + 1;
  return (
    <button
      type="button"
      onClick={() => void navigate({ to: "/devices" })}
      className="flex w-full items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <span className="inline-flex items-center gap-1">
        {/* This machine first, always reachable by definition. */}
        <StatusDot tone="emerald" />
        {views.map((view, index) => (
          // Index keys are fine: the cluster re-renders wholesale on
          // any registry change and carries no state.
          // eslint-disable-next-line react/no-array-index-key
          <StatusDot key={index} tone={view.tone} />
        ))}
      </span>
      <span>
        {total} devices
        {offline > 0 && ` · ${offline} offline`}
      </span>
      <ChevronRight aria-hidden className="ml-auto size-3 opacity-60" />
    </button>
  );
}
