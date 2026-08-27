import { PageShell } from "@/components/shared/PageShell";
import { AccountSection } from "./AccountSection";
import { ReachableSection } from "./ReachableSection";

// "/devices": the account's machines, on their own page. The account
// (sign in, this device's name, the device registry with its grants) is
// a fact about the account, not a preference of this machine, so it
// lives here rather than under Settings, along with the one device
// fact the other machines depend on: whether this one stays reachable
// to them.
export function DevicesPage() {
  return (
    <PageShell
      page="devices"
      eyebrow="Shigoto no Mori"
      title="Devices"
      watermark="機器"
      gap="gap-10"
    >
      <AccountSection />
      <ReachableSection />
    </PageShell>
  );
}
