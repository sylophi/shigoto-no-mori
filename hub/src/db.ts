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

// Deletes the device row, scoped to the account the worker authorized.
// The account_id guard means a row concurrently re-enrolled under
// another account cannot be deleted by a stale revoke. Returns true
// when a row was actually removed.
export async function deleteDevice(
  db: D1Database,
  deviceId: string,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM devices WHERE device_id = ? AND account_id = ?")
    .bind(deviceId, accountId)
    .run();
  return result.meta.changes > 0;
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
