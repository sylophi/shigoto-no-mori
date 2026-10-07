import { PageShell } from "@/components/shared/PageShell";
import { hasLocalHost } from "@/lib/localHost";
import { PAGES } from "@/lib/pages";
import { AccountSection } from "./AccountSection";

// "/account": the account and its machines, on their own page. The
// account (sign in, the device registry and its removals) is a fact
// about the account, not a preference of this machine, so it is a page
// of its own rather than a form under Settings -- along with the two
// device facts the other machines depend on, whether this one lets them
// control it and whether it stays reachable to them, which sit inside
// this device's own row instead of in a section of their own.
//
// On a desktop it is the Account row of Settings' list (SettingsPages
// keeps that list in the sidebar here). A hostless client has no
// forest of its own and this page is its home, so there it is Devices,
// and wears the devices watermark. Its name is lib/pages.ts's.
const HEADER = {
  title: PAGES.account.label,
  ...(hasLocalHost
    ? { eyebrow: PAGES.settings.label, watermark: "アカウント" }
    : { eyebrow: "Shigoto no Mori", watermark: "機器" }),
};

export function DevicesPage() {
  return (
    <PageShell page="devices" {...HEADER}>
      <AccountSection />
    </PageShell>
  );
}
