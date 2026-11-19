// In-memory stand-in for @clerk/react and @clerk/electron/react,
// aliased in by vite.base.ts only. Exposes exactly the names the
// renderer and web trees import, shaped so the fake host boots signed-in: the
// stub session's userId matches the fixture account id
// (fixtures.ts), so ClerkAccountSync sees "enrolled under this
// user" and never fires an enroll or sign-out.
import type { ReactNode } from "react";
import { FAKE_ACCOUNT_ID } from "@shigomori/ui/fixtures/fixtures.ts";

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

// ?deviceKey=lapsed: the session gone with the key still owed.
const lapsed =
  new URLSearchParams(location.search).get("deviceKey") === "lapsed";

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: !lapsed,
    userId: FAKE_ACCOUNT_ID,
    getToken: async () => "fake-session-token",
  };
}

// The profile the account page names the account by. Only the fields
// useAccountIdentity reads.
export function useUser() {
  return {
    user: {
      primaryEmailAddress: { emailAddress: "rin@example.com" },
      fullName: "Rin Hoshizora",
      username: null,
    },
  };
}

export function useClerk() {
  return {
    openSignIn: () => {
      console.info("[fake-host] clerk.openSignIn()");
    },
    signOut: async (callback?: () => Promise<void> | void) => {
      await callback?.();
    },
  };
}
