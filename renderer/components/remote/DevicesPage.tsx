import { PageShell } from "@/components/shared/PageShell";
import { AccountSection } from "./AccountSection";

// "/devices": the account's machines, on their own page. The account
// (sign in, the device registry with its grants and its removals) is a
// fact about the account, not a preference of this machine, so it lives
// here rather than under Settings -- along with the one device fact the
// other machines depend on, whether this one stays reachable to them,
// which now sits inside this device's own row instead of in a section
// of its own.
export function DevicesPage() {
  return (
    <PageShell
      page="devices"
      eyebrow="Shigoto no Mori"
      title="Devices"
      watermark="機器"
    >
      <AccountSection />
    </PageShell>
  );
}
