// The account's two buttons, drawn (ClerkSignInButton.tsx and
// ClerkSignOutButton.tsx drive Clerk behind them).
import { LogIn, LogOut } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";

// Signed in to Clerk with no device enrolled, the button retries the
// enrollment instead of asking for a sign-in.
export function SignInButtonView({
  retry,
  pending,
  onClick,
}: {
  retry: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" disabled={pending} onClick={onClick}>
      <LogIn />
      {retry ? (pending ? "Enrolling…" : "Retry enrollment") : "Sign in"}
    </Button>
  );
}

export function SignOutButtonView({
  pending,
  onClick,
  className,
}: {
  pending: boolean;
  onClick: () => void;
  className?: string;
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
