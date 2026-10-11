// Durable proof for the Clerk token file (main/electron/ClerkTokens.ts):
// it is the owner's alone, whatever the umask, since the machine's
// other accounts must not read the session it holds.
//
// Run: pnpm test clerk-tokens.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, it, vi } from "vitest";
import { CLERK_TOKEN_STORE } from "@shared/packaging/appName.mts";

// The OS cipher as a build without the async API has it.
vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => false,
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (bytes: Buffer) => bytes.toString(),
  },
}));

const { ClerkTokens, layer } = await import("../main/electron/ClerkTokens");

let userData: string;
afterEach(() => rmSync(userData, { recursive: true, force: true }));

it("writes the token file for the owner alone", async () => {
  userData = mkdtempSync(join(tmpdir(), "clerk-tokens-"));
  await Effect.runPromise(
    Effect.flatMap(ClerkTokens, (tokens) =>
      tokens.setItem("__clerk_client_jwt", "a session"),
    ).pipe(
      Effect.provide(layer(userData).pipe(Layer.provide(NodeServices.layer))),
    ),
  );
  const mode = statSync(join(userData, `${CLERK_TOKEN_STORE}.json`)).mode;
  assert.equal(mode & 0o777, 0o600);
});
