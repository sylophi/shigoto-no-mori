// "/devices" as it is drawn: the page's shell, which DevicesPage fills
// with the account's state.
import type { ReactNode } from "react";
import { PageShell } from "@/components/shared/PageShell";

export function DevicesPageView({ children }: { children: ReactNode }) {
  return (
    <PageShell
      page="devices"
      eyebrow="Shigoto no Mori"
      title="Devices"
      watermark="機器"
    >
      {children}
    </PageShell>
  );
}
