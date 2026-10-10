// The device registry in D1: one row per enrolled device, owned by
// one Clerk account, holding only the SHA-256 hash of its credential.
// Every query lives here so the schema (hub/migrations) has one
// consumer to keep in step. The Worker and the account's Durable
// Object both reach it.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WorkerEnv } from "./env.ts";

export class RegistryError extends Schema.TaggedError<RegistryError>()(
  "RegistryError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The device registry failed to ${this.operation}.`;
  }
}

export interface DeviceRow {
  device_id: string;
  account_id: string;
  name: string;
  platform: string;
  // What the device reports itself as (packages/contracts/src/deviceIcon.ts),
  // sent with every enrollment, so never NULL
  // (hub/migrations/0004_device_kind_required.sql).
  icon: string;
  // The device's static X25519 public key, base64url, sent with every
  // enrollment. NULL on a row enrolled before keys
  // (hub/migrations/0006_device_public_key.sql).
  public_key: string | null;
  credential_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

const DEVICE_COLUMNS =
  "device_id, account_id, name, platform, icon, public_key, credential_hash, created_at, last_seen_at";

// How long a revoked credential's tombstone answers
// (hub/migrations/0002_revoked_credentials.sql): long enough for a
// device put away for a couple of weeks to learn it was removed. After
// that it gets the plain refusal and signs out by hand. Enforced on
// the lookup. The rows themselves are pruned on each revoke.
const REVOKED_CREDENTIAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export class Registry extends Context.Service<
  Registry,
  {
    readonly byId: (
      deviceId: string,
    ) => Effect.Effect<DeviceRow | null, RegistryError>;
    // Credential auth resolves the presented credential by its hash. The
    // column is UNIQUE, so a hit names exactly one device and its account.
    readonly byCredentialHash: (
      credentialHash: string,
    ) => Effect.Effect<DeviceRow | null, RegistryError>;
    // The account's devices, oldest enrollment first.
    readonly listAccount: (
      accountId: string,
    ) => Effect.Effect<ReadonlyArray<DeviceRow>, RegistryError>;
    // The account's device ids, least recently seen first, for the
    // enroll cap's eviction. A device that never connected sorts by when
    // it enrolled.
    readonly stalestFirst: (
      accountId: string,
    ) => Effect.Effect<ReadonlyArray<string>, RegistryError>;
    // Inserts the device or, under the same account, rotates its
    // credential and key and refreshes name, platform and icon. False when the
    // device id is another account's: the guard in the statement holds
    // whatever a concurrent read saw.
    readonly upsert: (row: {
      readonly deviceId: string;
      readonly accountId: string;
      readonly name: string;
      readonly platform: string;
      readonly icon: string;
      readonly publicKey: string;
      readonly credentialHash: string;
      readonly createdAt: number;
    }) => Effect.Effect<boolean, RegistryError>;
    // Deletes the device row, scoped to the account, and tombstones its
    // credential in the same batch, so a device presenting it later is
    // told it was revoked. False when no row went.
    readonly remove: (
      deviceId: string,
      accountId: string,
    ) => Effect.Effect<boolean, RegistryError>;
    // Whether a hash that matched no device is a revoked credential's,
    // still inside the retention window.
    readonly isRevoked: (
      credentialHash: string,
    ) => Effect.Effect<boolean, RegistryError>;
    // Changes the name, the icon or both, scoped to the account. False
    // when no row matched.
    readonly update: (
      deviceId: string,
      accountId: string,
      patch: { readonly name?: string; readonly icon?: string },
    ) => Effect.Effect<boolean, RegistryError>;
    readonly touchLastSeen: (
      deviceId: string,
    ) => Effect.Effect<void, RegistryError>;
  }
>()("sm/hub/Registry") {}

const make = Effect.gen(function* () {
  const db = (yield* WorkerEnv).DB;

  const query = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new RegistryError({ operation, cause }),
    });

  const byId = Effect.fn("Registry.byId")(function* (deviceId: string) {
    return yield* query("read a device", () =>
      db
        .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE device_id = ?`)
        .bind(deviceId)
        .first<DeviceRow>(),
    );
  });

  const byCredentialHash = Effect.fn("Registry.byCredentialHash")(function* (
    credentialHash: string,
  ) {
    return yield* query("read a credential", () =>
      db
        .prepare(
          `SELECT ${DEVICE_COLUMNS} FROM devices WHERE credential_hash = ?`,
        )
        .bind(credentialHash)
        .first<DeviceRow>(),
    );
  });

  const listAccount = Effect.fn("Registry.listAccount")(function* (
    accountId: string,
  ) {
    const result = yield* query("list an account", () =>
      db
        .prepare(
          `SELECT ${DEVICE_COLUMNS} FROM devices WHERE account_id = ? ORDER BY created_at`,
        )
        .bind(accountId)
        .all<DeviceRow>(),
    );
    return result.results;
  });

  const stalestFirst = Effect.fn("Registry.stalestFirst")(function* (
    accountId: string,
  ) {
    const result = yield* query("list an account", () =>
      db
        .prepare(
          "SELECT device_id FROM devices WHERE account_id = ? ORDER BY COALESCE(last_seen_at, created_at), device_id",
        )
        .bind(accountId)
        .all<{ device_id: string }>(),
    );
    return result.results.map((row) => row.device_id);
  });

  const upsert = Effect.fn("Registry.upsert")(function* (row: {
    readonly deviceId: string;
    readonly accountId: string;
    readonly name: string;
    readonly platform: string;
    readonly icon: string;
    readonly publicKey: string;
    readonly credentialHash: string;
    readonly createdAt: number;
  }) {
    const result = yield* query("enroll a device", () =>
      db
        .prepare(
          `INSERT INTO devices (device_id, account_id, name, platform, icon, public_key, credential_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE
           SET name = excluded.name,
               platform = excluded.platform,
               icon = excluded.icon,
               public_key = excluded.public_key,
               credential_hash = excluded.credential_hash
           WHERE device_id = excluded.device_id
             AND account_id = excluded.account_id`,
        )
        .bind(
          row.deviceId,
          row.accountId,
          row.name,
          row.platform,
          row.icon,
          row.publicKey,
          row.credentialHash,
          row.createdAt,
        )
        .run(),
    );
    return result.meta.changes > 0;
  });

  const remove = Effect.fn("Registry.remove")(function* (
    deviceId: string,
    accountId: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const [, deleted] = yield* query("revoke a device", () =>
      db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO revoked_credentials (credential_hash, device_id, revoked_at)
             SELECT credential_hash, device_id, ? FROM devices
             WHERE device_id = ? AND account_id = ?`,
          )
          .bind(now, deviceId, accountId),
        db
          .prepare("DELETE FROM devices WHERE device_id = ? AND account_id = ?")
          .bind(deviceId, accountId),
        db
          .prepare("DELETE FROM revoked_credentials WHERE revoked_at < ?")
          .bind(now - REVOKED_CREDENTIAL_RETENTION_MS),
      ]),
    );
    return (deleted?.meta.changes ?? 0) > 0;
  });

  const isRevoked = Effect.fn("Registry.isRevoked")(function* (
    credentialHash: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* query("read a revoked credential", () =>
      db
        .prepare(
          "SELECT 1 FROM revoked_credentials WHERE credential_hash = ? AND revoked_at >= ?",
        )
        .bind(credentialHash, now - REVOKED_CREDENTIAL_RETENTION_MS)
        .first(),
    );
    return row !== null;
  });

  const update = Effect.fn("Registry.update")(function* (
    deviceId: string,
    accountId: string,
    patch: { readonly name?: string; readonly icon?: string },
  ) {
    // A field left undefined keeps its value (COALESCE against the column).
    const result = yield* query("change a device", () =>
      db
        .prepare(
          `UPDATE devices SET name = COALESCE(?, name), icon = COALESCE(?, icon)
           WHERE device_id = ? AND account_id = ?`,
        )
        .bind(patch.name ?? null, patch.icon ?? null, deviceId, accountId)
        .run(),
    );
    return result.meta.changes > 0;
  });

  const touchLastSeen = Effect.fn("Registry.touchLastSeen")(function* (
    deviceId: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* query("note a device seen", () =>
      db
        .prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?")
        .bind(now, deviceId)
        .run(),
    );
  });

  return Registry.of({
    byId,
    byCredentialHash,
    listAccount,
    stalestFirst,
    upsert,
    remove,
    isRevoked,
    update,
    touchLastSeen,
  });
});

export const layer = Layer.effect(Registry, make);
