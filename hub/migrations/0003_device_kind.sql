-- What a device looks like, beside its name: one of the kinds in
-- packages/contracts/src/deviceIcon.ts, as the device itself reported
-- it at enrollment or picked afterwards. NULL for a device enrolled before
-- kinds existed, which every client draws by its platform instead.
ALTER TABLE devices ADD COLUMN kind TEXT;
