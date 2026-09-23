-- Every device has a kind. 0003_device_kind.sql added the column
-- nullable, and a device enrolled before it left its row without one,
-- which every client then drew by its platform: a browser for a web
-- row, a desktop for a machine. Those rows get that same shape here,
-- and from now on the column refuses NULL, so a row is never without
-- one: an enrollment sends the kind beside the name
-- (shared/hub/protocol.ts EnrollRequestSchema). SQLite cannot add NOT
-- NULL to a column in place, so the table is rebuilt. The index goes
-- with the old table and is recreated.
UPDATE devices
SET kind = CASE WHEN platform = 'web' THEN 'browser' ELSE 'desktop' END
WHERE kind IS NULL;

CREATE TABLE devices_next (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

INSERT INTO devices_next (device_id, account_id, name, platform, kind, credential_hash, created_at, last_seen_at)
SELECT device_id, account_id, name, platform, kind, credential_hash, created_at, last_seen_at
FROM devices;

DROP TABLE devices;
ALTER TABLE devices_next RENAME TO devices;
CREATE INDEX devices_account_id ON devices (account_id);
