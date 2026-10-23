// A launch whose store won't open (an import the 2.x files refused, a
// database that can't be read): the app can't run, so the boot error
// says why, with what the engine's doctor finds. The doctor opens the
// store inside its own run, reads the 2.x files leniently where the
// store refused them, and names the file at fault the way `sm doctor`
// does.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Doctor from "@shigomori/engine/Doctor";
import type { Flavor } from "@shigomori/engine/flavor";
import { doctorLayer } from "@shigomori/engine/layer";
import { StoreImportError } from "@shigomori/engine/migrations/importJson";
import { StoreOpenError } from "@shigomori/engine/Store";
import { storeErrorOf } from "@shigomori/engine/storeErrors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const isStoreFailure = Schema.is(
  Schema.Union([StoreOpenError, StoreImportError]),
);

// What the doctor found wrong, one line per check that failed (a
// warning is about something else: a shell hook, a leftover), and
// whether a newer version of the app made the store; null when `error`
// is not the store's.
export async function storeFailureReport(
  error: unknown,
  options: {
    readonly flavor: Flavor;
    readonly macfs: string;
    readonly version: string;
  },
): Promise<{ readonly report: string; readonly newer: boolean } | null> {
  if (!isStoreFailure(error)) return null;
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Doctor.Doctor).run({
        version: options.version,
        executable: process.execPath,
        terminal: false,
      });
    }).pipe(
      // The boot error waits on it: a report it can't have in time is
      // left out.
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.succeed(null),
      }),
      Effect.provide(
        doctorLayer({
          flavor: options.flavor,
          macfs: options.macfs,
          open: (filename) => SqliteClient.make({ filename }),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ).catch(() => null);
  const findings =
    report?.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.title}: ${check.detail}`) ?? [];
  return {
    report: [error.message, ...findings].join("\n"),
    newer: madeByNewer(error),
  };
}

// Whether a newer version of the app made the store that would not
// open.
const madeByNewer = (error: unknown): boolean =>
  error instanceof StoreOpenError &&
  storeErrorOf(error.cause)?.category === "newer";
