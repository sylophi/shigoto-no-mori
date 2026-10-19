// Durable proof for the Clerk token file (main/electron/ClerkTokens.ts):
// it is the owner's alone, whatever the umask, since the machine's
// other accounts must not read the session it holds. A key's removal
// reaches the file once acknowledged, a failed write before it
// included, and a read's re-encryption never writes back a key removed
// meanwhile.
//
// Run: pnpm test clerk-tokens.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PlatformError from "effect/PlatformError";
import { afterEach, it, vi } from "vitest";
import { CLERK_TOKEN_STORE } from "@shared/packaging/appName.mts";

// A decrypt the test answers by hand.
const held = vi.hoisted(() => ({
  decrypt: null as
    | null
    | ((
        bytes: Buffer,
      ) => Promise<{ result: string; shouldReEncrypt: boolean }>),
}));

// The OS cipher as a build without the async API has it, unless a
// test holds the decrypt.
vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => held.decrypt !== null,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: (bytes: Buffer) => held.decrypt?.(bytes),
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (bytes: Buffer) => bytes.toString(),
  },
}));

const { ClerkTokens, layer } = await import("../main/electron/ClerkTokens");

const KEY = "__clerk_client_jwt";

let userData: string;
afterEach(() => {
  held.decrypt = null;
  rmSync(userData, { recursive: true, force: true });
});

const tokenFile = () => join(userData, `${CLERK_TOKEN_STORE}.json`);
const onDisk = () =>
  JSON.parse(readFileSync(tokenFile(), "utf8")) as Record<string, unknown>;

// A store over userData, on Node's filesystem unless given another.
const runtimeOver = (fs?: Layer.Layer<FileSystem.FileSystem>) =>
  ManagedRuntime.make(
    layer(userData).pipe(
      Layer.provide(
        fs === undefined
          ? NodeServices.layer
          : Layer.provideMerge(fs, NodeServices.layer),
      ),
    ),
  );

// Node's filesystem whose next rename fails, once.
const renameFailsOnce = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => {
    let failed = false;
    return {
      ...fs,
      rename: (from: string, to: string) => {
        if (failed) return fs.rename(from, to);
        failed = true;
        return Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
          }),
        );
      },
    };
  }),
).pipe(Layer.provide(NodeServices.layer));

it("writes the token file for the owner alone", async () => {
  userData = mkdtempSync(join(tmpdir(), "clerk-tokens-"));
  const runtime = runtimeOver();
  await runtime.runPromise(
    ClerkTokens.use((tokens) => tokens.setItem(KEY, "a session")),
  );
  await runtime.dispose();
  assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
});

it("a removal retried after a failed write reaches the file", async () => {
  userData = mkdtempSync(join(tmpdir(), "clerk-tokens-"));
  const runtime = runtimeOver();
  await runtime.runPromise(
    ClerkTokens.use((tokens) => tokens.setItem(KEY, "a session")),
  );
  assert.ok(KEY in onDisk(), "the key is on disk before the removal");
  await runtime.dispose();

  const failing = runtimeOver(renameFailsOnce);
  await assert.rejects(
    failing.runPromise(ClerkTokens.use((tokens) => tokens.removeItem(KEY))),
  );
  await failing.runPromise(ClerkTokens.use((tokens) => tokens.removeItem(KEY)));
  await failing.dispose();
  assert.ok(!(KEY in onDisk()), "the retried removal left the key on disk");

  const fresh = runtimeOver();
  const read = await fresh.runPromise(
    ClerkTokens.use((tokens) => tokens.getItem(KEY)),
  );
  await fresh.dispose();
  assert.equal(read, null, "a fresh store read the removed key");
});

it("a read's re-encryption leaves a key removed during its decrypt removed", async () => {
  userData = mkdtempSync(join(tmpdir(), "clerk-tokens-"));
  let entered!: () => void;
  const decrypting = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  held.decrypt = async (bytes) => {
    entered();
    await released;
    return { result: bytes.toString(), shouldReEncrypt: true };
  };
  const runtime = runtimeOver();
  await runtime.runPromise(
    ClerkTokens.use((tokens) => tokens.setItem(KEY, "a session")),
  );

  const reading = runtime.runPromise(
    ClerkTokens.use((tokens) => tokens.getItem(KEY)),
  );
  await decrypting;
  const removing = runtime.runPromise(
    ClerkTokens.use((tokens) => tokens.removeItem(KEY)),
  );
  // Time for a removal that does not wait for the read to land first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  assert.equal(await reading, "a session");
  await removing;

  assert.ok(!(KEY in onDisk()), "the read wrote the removed key back to disk");
  const after = await runtime.runPromise(
    ClerkTokens.use((tokens) => tokens.getItem(KEY)),
  );
  await runtime.dispose();
  assert.equal(after, null, "the store reads the removed key");
});
