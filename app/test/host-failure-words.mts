// Durable proof that the dialog of a host whose store won't open sends
// you to the doctor only when the doctor can do something about it: a
// store a newer version of the app made is opened by updating, and its
// dialog ends there.
//
// Run: pnpm test host-failure-words.
import assert from "node:assert/strict";
import { StoreOpenError } from "@shigomori/engine/Store";
import { StoreError } from "@shigomori/engine/storeErrors";
import { it } from "vitest";
import { hostFailureWords } from "../main/hostFailureWords.ts";

const failing = (category: "newer" | "damaged") => {
  const error = new StoreOpenError({
    path: "/data/store.db",
    cause: new StoreError({ category, cause: null }),
  });
  return {
    message: error.message,
    store: {
      report: `${error.message}\nstore: /data/store.db can't be opened, so no command can run`,
      newer: category === "newer",
    },
  };
};

it("ends a newer version's store at updating the app", () => {
  const { body } = hostFailureWords(failing("newer"), "prod");
  assert.equal(
    body,
    "Could not open the store at /data/store.db. It was made by a newer version of the app; update the app.",
  );
});

it("sends a damaged store to the doctor", () => {
  const { body } = hostFailureWords(failing("damaged"), "prod");
  assert.match(
    body,
    /Run `sm doctor` in a terminal for the repairs it offers\.$/,
  );
});
