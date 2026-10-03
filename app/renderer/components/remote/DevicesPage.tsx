import { AccountSection } from "./AccountSection";
import { DevicesPageView } from "./DevicesPageView";

// "/devices": the account's machines, on their own page. The account
// (sign in, the device registry and its removals) is a fact about the
// account, not a preference of this machine, so it lives here rather
// than under Settings -- along with the two device facts the other
// machines depend on, whether this one lets them control it and
// whether it stays reachable to them, which sit inside this device's
// own row instead of in a section of their own.
export function DevicesPage() {
  return (
    <DevicesPageView>
      <AccountSection />
    </DevicesPageView>
  );
}
