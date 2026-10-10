import { useAccountStatus } from "@/hooks/account/useAccount";
import { hasLocalHost } from "@/lib/localHost";
import { ClerkSignInButton } from "@/components/account/ClerkSignInButton";
import {
  AccountLoadingView,
  NotConfiguredPanelView,
  SignedOutPanelView,
} from "@shigomori/ui/views/remote/AccountPanelsView.tsx";
import { DeviceRegistry } from "./DeviceRegistry";

// "Account": sign in to the device hub so this device can reach the
// account's other devices. Three states. Not
// configured (no account service in this build's launch env) is one
// panel that says so and how to fix it. Signed out is one panel with
// one button. Signed in, the whole page is the device registry, which
// carries the account line (who is signed in, sign-out) itself, since
// that line is the registry's caption and nothing else.
export function AccountSection() {
  const { data: status } = useAccountStatus();
  if (status === undefined) return <AccountLoadingView />;
  if (!status.configured) {
    return (
      <NotConfiguredPanelView isDev={window.api.isDev} desktop={hasLocalHost} />
    );
  }
  if (!status.signedIn) {
    return (
      <SignedOutPanelView
        desktop={hasLocalHost}
        signIn={<ClerkSignInButton />}
      />
    );
  }
  return <DeviceRegistry accountId={status.accountId} />;
}
