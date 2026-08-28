// The one Clerk mount decision, shared by both shells: mount the given
// ClerkProvider (the @clerk/electron/react flavor on desktop, plain
// @clerk/react on web — the only difference between the two boots) iff
// the build carries a publishable key, and keep ClerkAccountSync inside
// it so the session-to-credential reconciler can never be forgotten or
// mounted outside the provider. Components under an absent provider
// must not call Clerk hooks, which the status.configured gates in the
// account UI guarantee (configured requires the key, so a configured
// status implies this gate mounted the provider).
import type { ComponentType, ReactNode } from "react";
import type { ClerkProviderProps } from "@clerk/react";
import { clerkAppearance } from "@/lib/clerkAppearance";
import { ClerkAccountSync } from "./ClerkAccountSync";

type ProviderComponent = ComponentType<{
  publishableKey: string;
  appearance: ClerkProviderProps["appearance"];
  children: ReactNode;
}>;

export function ClerkGate({
  Provider,
  children,
}: {
  Provider: ProviderComponent;
  children: ReactNode;
}) {
  const publishableKey = window.api.clerkPublishableKey;
  if (!publishableKey) return children;
  return (
    <Provider publishableKey={publishableKey} appearance={clerkAppearance}>
      <ClerkAccountSync />
      {children}
    </Provider>
  );
}
