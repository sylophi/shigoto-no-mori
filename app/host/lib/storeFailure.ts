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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const isStoreFailure = Schema.is(
  Schema.Union([StoreOpenError, StoreImportError]),
);

// What the doctor found wrong, one line per check that warned or
// failed, or null when `error` is not the store's.
export async function storeFailureReport(
  error: unknown,
  options: {
    readonly flavor: Flavor;
    readonly macfs: string;
    readonly version: string;
  },
): Promise<string | null> {
  if (!isStoreFailure(error)) return null;
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Doctor.Doctor).run({
        version: options.version,
        executable: process.execPath,
        terminal: false,
      });
    }).pipe(
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
      .filter((check) => check.status !== "ok")
      .map((check) => `${check.title}: ${check.detail}`) ?? [];
  return [error.message, ...findings].join("\n");
}
