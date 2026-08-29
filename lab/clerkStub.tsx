// In-memory stand-in for @clerk/react and @clerk/electron/react,
// aliased in by vite.lab.config.ts only. Exposes exactly the names the
// renderer/web trees import, shaped so the lab boots signed-in: the
// stub session's userId matches the fixture account id
// (lab/fixtures.ts), so ClerkAccountSync sees "enrolled under this
// user" and never fires an enroll or sign-out.
import type { ReactNode } from "react";
import { LAB_ACCOUNT_ID } from "./fixtures";

// Referenced by type-only imports (ClerkProviderProps in ClerkGate and
// clerkAppearance). Loose on purpose: nothing reads it at runtime.
export type ClerkProviderProps = {
  publishableKey?: string;
  appearance?: unknown;
  children?: ReactNode;
};

export function ClerkProvider({ children }: ClerkProviderProps) {
  return children;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: LAB_ACCOUNT_ID,
    getToken: async () => "lab-session-token",
  };
}

export function useClerk() {
  return {
    openSignIn: () => {
      console.info("[lab] clerk.openSignIn()");
    },
    signOut: async (callback?: () => Promise<void> | void) => {
      await callback?.();
    },
  };
}

export function SignIn() {
  return (
    <div className="rounded-md border border-border p-6 text-sm text-muted-foreground">
      [lab] Clerk &lt;SignIn /&gt; renders here
    </div>
  );
}
