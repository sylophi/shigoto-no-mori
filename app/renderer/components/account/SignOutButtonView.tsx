// The sign-out button's look (ClerkSignOutButton wires it to Clerk).
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignOutButtonView({
  className,
  pending = false,
  onClick,
}: {
  className?: string;
  // A sign-out already on its way.
  pending?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      disabled={pending}
      onClick={onClick}
    >
      <LogOut />
      Sign out
    </Button>
  );
}
