-- Tombstones for revoked device credentials. A revoke deletes the
-- device row, so a device that was offline at the time (asleep, quit)
-- would otherwise get the same "invalid device credential" as a
-- garbage token when it next dials, and could not tell it was removed
-- from the account. The hash of the revoked credential is kept here
-- so every credentialed route can answer a typed "device revoked"
-- instead, which the app reads as its cue to sign out. Rows are
-- pruned on each revoke once older than the retention window.
CREATE TABLE revoked_credentials (
  credential_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE INDEX revoked_credentials_revoked_at ON revoked_credentials (revoked_at);
