// How an invoke's outcome crosses the Electron wire (shared/ipc/
// transport.ts): main settles a handler into a value, Electron's IPC
// and the context bridge copy it as structured data, and the renderer
// unsettles it into the result or the error again. A contract error
// comes back as its class with its fields, and anything else as a
// plain Error with its message.
//
// covers: app/main/ipc/register.ts app/main/preloadTransport.ts app/renderer/electronApi.ts
import assert from "node:assert/strict";
import {
  BranchNotMergedError,
  isBranchNotMergedError,
} from "@shigomori/contracts/errors";
import { settle, unsettle } from "@shared/ipc/transport";
import { it } from "vitest";

// What the wire does to a value: Electron's IPC structured-clones it.
const across = async (run: Promise<unknown>) =>
  structuredClone(await settle(run));

it("a resolved value crosses as it is", async () => {
  const settled = await across(Promise.resolve({ ok: 1 }));
  assert.deepEqual(unsettle(settled), { ok: 1 });
});

it("a contract error comes back as its class, fields and message", async () => {
  const settled = await across(
    Promise.reject(new BranchNotMergedError({ branch: "feat/x" })),
  );
  assert.throws(
    () => unsettle(settled),
    (error: unknown) =>
      isBranchNotMergedError(error) &&
      error.branch === "feat/x" &&
      error.message === "Branch 'feat/x' has unmerged commits.",
  );
});

it("any other failure comes back as a plain Error with its message", async () => {
  const settled = await across(Promise.reject(new Error("boom")));
  assert.throws(
    () => unsettle(settled),
    (error: unknown) =>
      error instanceof Error &&
      !isBranchNotMergedError(error) &&
      error.message === "boom",
  );
});
