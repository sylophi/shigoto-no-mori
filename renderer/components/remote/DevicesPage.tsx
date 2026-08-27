import { PageHeader } from "@/components/shared/PageHeader";
import { AccountSection } from "./AccountSection";

// "/devices": everything about this account's machines, on its own page.
// The account (sign in, this device's name, the device registry with its
// grants) is a fact about the account, not a preference of this machine,
// so it lives here rather than under Settings — Settings is how a device
// behaves, Devices is what devices exist and how they reach each other.
export function DevicesPage() {
  return (
    <div data-doubutsu-page="devices" className="flex h-full flex-col">
      <PageHeader eyebrow="Shigoto no Mori" title="Devices" watermark="機器" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <AccountSection />
        </div>
      </div>
    </div>
  );
}
