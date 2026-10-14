// Durable proof for a build with no account service (no Clerk
// publishable key, as a dev checkout without .env.local): ClerkGate
// mounts no ClerkProvider there, and the migration page's sign-in step
// (useSignInStep) must run without one, offering no sign-in, rather
// than call a Clerk hook and land the migration in the error boundary.
//
// Run: pnpm test sign-in-no-account.
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { it } from "vitest";
import { useSignInStep } from "@/components/steps/useSignInStep";
import { ApiProvider, type RendererApi } from "@/lib/runtime/pageApi";

// The page's api as a build with no key hands it over: the facts the
// hook reads, and no calls.
const api = {
  deviceId: "sign-in-no-account",
  isElectron: true,
  clerkPublishableKey: "",
} as RendererApi;

it("offers no sign-in, and touches no Clerk hook, without an account service", () => {
  let seen: ReturnType<typeof useSignInStep> | undefined;
  function Probe() {
    seen = useSignInStep(true);
    return null;
  }
  // The page's api and the app's query client, and no ClerkProvider,
  // as ClerkGate leaves it.
  renderToString(
    createElement(
      ApiProvider,
      { api },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Probe),
      ),
    ),
  );
  assert.equal(seen?.signIn, null);
  assert.equal(seen?.needsDeviceKey, false);
});
