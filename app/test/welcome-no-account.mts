// Durable proof for a build with no account service (no Clerk
// publishable key, as a dev checkout without .env.local): ClerkGate
// mounts no ClerkProvider there, and the welcome and migration pages'
// sign-in step (useSignInStep) must run without one, offering no
// sign-in, rather than call a Clerk hook and land the first run in the
// error boundary.
//
// Run: pnpm test welcome-no-account.
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { it } from "vitest";

// The bridge as a build with no key hands it over. The hooks' imports
// read window.api at load.
const api = { deviceId: "welcome-no-account", isElectron: true };
// @ts-expect-error a stand-in for the preload's window, with no key
globalThis.window = { api };
const { useSignInStep } = await import("@/components/steps/useSignInStep");

it("offers no sign-in, and touches no Clerk hook, without an account service", () => {
  let seen: ReturnType<typeof useSignInStep> | undefined;
  function Probe() {
    seen = useSignInStep(true);
    return null;
  }
  // The app's query client, and no ClerkProvider, as ClerkGate leaves it.
  renderToString(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Probe),
    ),
  );
  assert.equal(seen?.signIn, null);
  assert.equal(seen?.needsDeviceKey, false);
});
