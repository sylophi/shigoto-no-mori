// The shared sign-out affordance, split into its own component so no
// shell layout ever calls a Clerk hook itself: mount this only on
// paths the status.configured gates keep off the tree when Clerk is
// absent (see ClerkGate).
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";

export function ClerkSignOutButton({
  className,
  onSignedOut,
}: {
  className?: string;
  onSignedOut?: () => void;
}) {
  const signOut = useClerkSignOut();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      disabled={signOut.isPending}
      onClick={() => signOut.mutate(undefined, { onSuccess: onSignedOut })}
    >
      <LogOut />
      Sign out
    </Button>
  );
}
