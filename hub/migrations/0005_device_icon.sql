-- The column 0003_device_kind.sql added as `kind` holds the device's
-- icon (one of shared/account/deviceIcon.ts), so it is named for that.
-- The wire field and every reader were renamed with it: deploy this
-- before the Worker that reads `icon`.
ALTER TABLE devices RENAME COLUMN kind TO icon;
