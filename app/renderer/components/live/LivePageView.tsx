import type { ReactNode } from "react";
import { Radio } from "lucide-react";
import { PAGE_BODY } from "@/components/shared/PageShellView";
import { PageHeaderView } from "@/components/shared/PageHeaderView";

// Everything running right now, across the account, on one page
// (LivePage.tsx gathers it): each worktree with something live is a
// card, filed under its device.
export function LivePageView({
  eyebrow,
  trailing,
  state,
  children,
}: {
  eyebrow: string;
  // Stop all scripts, while there are any to stop.
  trailing: ReactNode;
  // "loading" holds the body empty until every device has answered.
  state: "loading" | "quiet" | "devices";
  // The devices' sections (LiveDeviceSectionView).
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeaderView
        eyebrow={eyebrow}
        title="Live"
        watermark="稼働"
        trailing={trailing}
      />
      <div className={PAGE_BODY}>
        {state === "quiet" ? (
          <Quiet />
        ) : state === "devices" ? (
          <div className="flex flex-col gap-8">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

// One device's cards, under its heading when there is more than one.
export function LiveDeviceSectionView({
  heading,
  children,
}: {
  // The device's heading (DeviceHeadingView), or null with one device.
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={heading ? undefined : "Live"}
      className="flex flex-col gap-3"
    >
      {heading}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,--spacing(88)),1fr))] items-start gap-4">
        {children}
      </div>
    </section>
  );
}

// Nothing live anywhere: say what would show here.
function Quiet() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Radio aria-hidden className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">All quiet in the forest</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Agents waiting on you, dev servers and other scripts, forwarded ports
          and mirrors show up here, on any of your devices.
        </p>
      </div>
    </div>
  );
}
