// The account's device registry, drawn (DeviceRegistry.tsx binds it):
// the account line with its sign-out, what is wrong with this device's
// sign-in, and one row per machine.
import type { ReactNode } from "react";
import { ErrorBanner } from "../../primitives/error-banner.tsx";
import { abbreviateId } from "../../lib/abbreviateId.ts";

export type RegistryList =
  | { state: "loading" }
  // A failed list is unknown, not empty. The message is null when the
  // banner above already named the cause.
  | { state: "failed"; message: string | null }
  | { state: "ready"; rows: ReactNode[] };

export function DeviceRegistryView({
  account,
  signOut,
  banner,
  list,
}: {
  // Who is signed in (AccountIdentityView).
  account: ReactNode;
  signOut: ReactNode;
  // What is wrong with this device's sign-in, if anything.
  banner: ReactNode;
  list: RegistryList;
}) {
  return (
    <section className="flex flex-col gap-5">
      {/* The account is one thin line -- who is signed in -- and the
          sign-out sits with it: ending the session is what removes THIS
          machine from the account (see the Remove button's note in the
          row). A hub account has no other properties, and the rows say
          everything about its devices, so no headcount repeats them. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {account}
        {signOut}
      </div>

      {banner}

      {list.state === "loading" ? (
        <p className="text-xs text-muted-foreground/70">
          Loading devices&hellip;
        </p>
      ) : list.state === "failed" ? (
        list.message !== null && <ErrorBanner>{list.message}</ErrorBanner>
      ) : list.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No devices yet.</p>
      ) : (
        <ul className="divide-y divide-border">{list.rows}</ul>
      )}
    </section>
  );
}

// The person, not the account's key: the hub keys on the Clerk user
// id, but nobody recognises that string as themselves, so the line
// reads the email (or name) Clerk knows. With no profile to read (still
// loading, or no session at all) the line names the account by its
// abbreviated id and does not call that "signed in". A leaf, like the
// sign-out button beside it, so Clerk's session churn re-renders one
// span and not the registry.
export function AccountIdentityView({
  person,
  accountId,
}: {
  // The email or name Clerk knows, null with no profile to read.
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

// The banner shape both sign-in problems share: the sentence, and the
// button beside it.
export function SignInBannerView({
  children,
  signIn,
}: {
  children: ReactNode;
  signIn: ReactNode;
}) {
  return (
    <ErrorBanner className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1 basis-64">{children}</span>
      {signIn}
    </ErrorBanner>
  );
}
