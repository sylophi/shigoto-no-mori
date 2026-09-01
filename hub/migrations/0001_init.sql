-- Device registry. One row per enrolled device (the app's per-root
-- UUID), owned by exactly one Clerk account. Only the SHA-256 hash of
-- the device credential is stored, the raw credential leaves the
-- Worker exactly once at enrollment. Timestamps are epoch
-- milliseconds, last_seen_at stays NULL until the first hub
-- connection.
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX devices_account_id ON devices (account_id);
