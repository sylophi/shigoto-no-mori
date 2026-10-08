// The version of what crosses the wire between two builds: every
// contract call's payload, result and push, as their schemas encode
// them. fixtures/wire/v<PROTOCOL_VERSION>.json holds one encoded sample
// of each, and test/wire.test.ts holds every schema to its samples, so
// a change an older build could not read fails there. Such a change
// bumps this version, with a new samples file.
export const PROTOCOL_VERSION = 1;
