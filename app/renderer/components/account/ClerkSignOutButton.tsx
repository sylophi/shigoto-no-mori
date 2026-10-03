// The shared sign-out affordance, split into its own component so no
// shell layout ever calls a Clerk hook itself: mount this only on
// paths the status.configured gates keep off the tree when Clerk is
// absent (see ClerkGate). SignOutButtonView draws it.
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
import { SignOutButtonView } from "./SignOutButtonView";

export function ClerkSignOutButton({ className }: { className?: string }) {
  const signOut = useClerkSignOut();
  return (
    <SignOutButtonView
      className={className}
      pending={signOut.isPending}
      onClick={() => signOut.mutate()}
    />
  );
}
