// D1 access for the device registry. All queries live here so the
// schema (hub/migrations/0001_init.sql) has one consumer to keep in
// sync.

export interface DeviceRow {
  device_id: string;
  account_id: string;
  name: string;
  platform: string;
  credential_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

const DEVICE_COLUMNS =
  "device_id, account_id, name, platform, credential_hash, created_at, last_seen_at";

export async function getDeviceById(
  db: D1Database,
  deviceId: string,
): Promise<DeviceRow | null> {
  return await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE device_id = ?`)
    .bind(deviceId)
    .first<DeviceRow>();
}

// Credential auth resolves the presented credential by its SHA-256
// hash. The column is UNIQUE, so a hit identifies exactly one device
// and with it the account.
export async function getDeviceByCredentialHash(
  db: D1Database,
  credentialHash: string,
): Promise<DeviceRow | null> {
  return await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE credential_hash = ?`)
    .bind(credentialHash)
    .first<DeviceRow>();
}

// Auth and list in one round trip for GET /devices. The subquery
// resolves the caller's account from the presented credential hash and
// the outer query returns that whole account's devices. An empty
// result means the credential matched no device, which the caller
// turns into a 401. Every returned row carries the same account_id, so
// the caller reads it from the first row for the presence lookup.
export async function listDevicesByCredentialHash(
  db: D1Database,
  credentialHash: string,
): Promise<DeviceRow[]> {
  const result = await db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM devices
       WHERE account_id = (SELECT account_id FROM devices WHERE credential_hash = ?)
       ORDER BY created_at`,
    )
    .bind(credentialHash)
    .all<DeviceRow>();
  return result.results;
}

// The account's device ids, least recently seen first, for the enroll
// cap and its eviction. A device that never connected sorts by when it
// enrolled.
export async function listAccountDeviceIds(
  db: D1Database,
  accountId: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      "SELECT device_id FROM devices WHERE account_id = ? ORDER BY COALESCE(last_seen_at, created_at), device_id",
    )
    .bind(accountId)
    .all<{ device_id: string }>();
  return result.results.map((row) => row.device_id);
}

// Enrollment upsert. Re-enrolling an existing device rotates the
// credential and refreshes name and platform but keeps created_at and
// last_seen_at. The ON CONFLICT update is guarded by
// account_id = excluded.account_id so it fails closed regardless of
// what a concurrent read saw. Two enrolls of the same deviceId from
// different accounts cannot cross-bind. The losing account's UPDATE
// matches no row and writes nothing. Returns true when a row was
// written (a fresh insert or a same-account re-enroll) and false when
// the guard suppressed a cross-account conflict, so the caller can
// treat that as the 409 collision.
export async function upsertDevice(
  db: D1Database,
  row: {
    deviceId: string;
    accountId: string;
    name: string;
    platform: string;
    credentialHash: string;
    createdAt: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO devices (device_id, account_id, name, platform, credential_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE
       SET name = excluded.name,
           platform = excluded.platform,
           credential_hash = excluded.credential_hash
       WHERE device_id = excluded.device_id
         AND account_id = excluded.account_id`,
    )
    .bind(
      row.deviceId,
      row.accountId,
      row.name,
      row.platform,
      row.credentialHash,
      row.createdAt,
    )
    .run();
  return result.meta.changes > 0;
}

// How long a revoked credential's tombstone is kept
// (hub/migrations/0002_revoked_credentials.sql). Long enough for a
// device that was put away for a season to learn it was removed;
// after that it gets the plain refusal and signs out by hand.
export const REVOKED_CREDENTIAL_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// Deletes the device row, scoped to the account the worker authorized.
// The account_id guard means a row concurrently re-enrolled under
// another account cannot be deleted by a stale revoke. The row's
// credential hash is tombstoned in the same batch, so a device that
// presents the dead credential later is told it was revoked rather
// than that its credential is unknown. Returns true when a row was
// actually removed.
export async function deleteDevice(
  db: D1Database,
  deviceId: string,
  accountId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const [, deleted] = await db.batch([
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
  ]);
  return deleted.meta.changes > 0;
}

// Whether a credential hash that matched no device is a revoked one:
// the tombstone deleteDevice wrote, still inside the retention window.
export async function isRevokedCredentialHash(
  db: D1Database,
  credentialHash: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT device_id FROM revoked_credentials WHERE credential_hash = ?",
    )
    .bind(credentialHash)
    .first<{ device_id: string }>();
  return row !== null;
}
// Renames the device row, scoped to the account the worker authorized
// like deleteDevice. Returns true when a row was actually renamed.
export async function renameDevice(
  db: D1Database,
  deviceId: string,
  accountId: string,
  name: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE devices SET name = ? WHERE device_id = ? AND account_id = ?",
    )
    .bind(name, deviceId, accountId)
    .run();
  return result.meta.changes > 0;
}

export async function touchLastSeen(
  db: D1Database,
  deviceId: string,
  timestamp: number,
): Promise<void> {
  await db
    .prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?")
    .bind(timestamp, deviceId)
    .run();
}
