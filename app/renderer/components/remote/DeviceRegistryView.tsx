// The device registry's frame as it is drawn (DeviceRegistry fills it):
// the account line with its sign-out, the slot for a sign-in problem,
// then the list, whose rows are DeviceRegistryRowView.
import type { ReactNode } from "react";
import { abbreviateId } from "@/lib/abbreviateId";

// The sign-out button's place on the account line: tucked into the
// line's height and as quiet as its words.
export const DEVICE_REGISTRY_SIGN_OUT_CLASS = "-my-1 text-muted-foreground";

export function DeviceRegistryView({
  identity,
  signOut,
  banner,
  children,
}: {
  // Who is signed in (AccountIdentityView).
  identity: ReactNode;
  // The sign-out button.
  signOut: ReactNode;
  // What is wrong with this device's sign-in, if anything.
  banner: ReactNode;
  // The list (DeviceListView), or the line saying why there is none.
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      {/* The account is one thin line -- who is signed in -- and the
          sign-out sits with it: ending the session is what removes THIS
          machine from the account (see the Remove button's note in the
          row). A hub account has no other properties, and the rows say
          everything about its devices, so no headcount repeats them. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {identity}
        {signOut}
      </div>

      {banner}

      {children}
    </section>
  );
}

// The rows, this device first.
export function DeviceListView({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border">{children}</ul>;
}

// The person, not the account's key: the hub keys on the Clerk user
// id, but nobody recognises that string as themselves, so the line
// reads the email (or name) Clerk knows. With no profile to read (still
// loading, or no session at all) the line names the account by its
// abbreviated id and does not call that "signed in".
export function AccountIdentityView({
  person,
  accountId,
}: {
  person: string | null;
  accountId: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {person === null ? "Account" : "Signed in as"}{" "}
      <span className="font-medium text-foreground select-text">
        {person ?? abbreviateId(accountId)}
      </span>
    </p>
  );
}
