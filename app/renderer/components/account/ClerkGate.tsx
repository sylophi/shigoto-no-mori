// The one Clerk mount decision, shared by both shells: mount the given
// ClerkProvider (the @clerk/electron/react flavor on desktop, plain
// @clerk/react on web, the only difference between the two boots) iff
// the build carries a publishable key, and keep ClerkAccountSync inside
// it so the session-to-credential reconciler can never be forgotten or
// mounted outside the provider. Components under an absent provider
// must not call Clerk hooks, which the status.configured gates in the
// account UI guarantee (configured requires the key, so a configured
// status implies this gate mounted the provider).
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import type { ClerkProviderProps } from "@clerk/react";
import { clerkAppearance } from "@/lib/clerkAppearance";
import { useWindowRoot } from "@/lib/themeRoot";
import { ClerkAccountSync } from "./ClerkAccountSync";
import { useApi } from "@/lib/runtime/pageApi";

export type ClerkProviderComponent = ComponentType<{
  publishableKey: string;
  appearance: ClerkProviderProps["appearance"];
  telemetry: ClerkProviderProps["telemetry"];
  children: ReactNode;
}>;

export function ClerkGate({
  Provider,
  children,
}: {
  Provider: ClerkProviderComponent;
  children: ReactNode;
}) {
  const api = useApi();
  const publishableKey = api.clerkPublishableKey;
  const appearance = useThemedAppearance();
  if (!publishableKey) return children;
  return (
    // No telemetry: the app sends nothing Clerk does not need to sign in,
    // and the window's CSP refuses its host.
    <Provider
      publishableKey={publishableKey}
      appearance={appearance}
      telemetry={false}
    >
      <ClerkAccountSync />
      {children}
    </Provider>
  );
}

// Clerk mounts its sign-in modal on the page's body, outside the theme
// root the tokens live on, so the appearance's token references are
// resolved against the root and handed over as values, again whenever
// the root's theme changes.
function useThemedAppearance(): ClerkProviderProps["appearance"] {
  const root = useWindowRoot();
  const [appearance, setAppearance] = useState(() => resolvedAppearance(root));
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setAppearance(resolvedAppearance(root)),
    );
    observer.observe(root, { attributeFilter: ["class", "data-palette"] });
    return () => observer.disconnect();
  }, [root]);
  return appearance;
}

function resolvedAppearance(
  root: HTMLElement,
): ClerkProviderProps["appearance"] {
  const style = getComputedStyle(root);
  const variables = Object.fromEntries(
    Object.entries(clerkAppearance?.variables ?? {}).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value.replace(
            /var\((--[\w-]+)\)/g,
            (reference, name: string) =>
              style.getPropertyValue(name).trim() || reference,
          )
        : value,
    ]),
  );
  return { ...clerkAppearance, variables };
}
