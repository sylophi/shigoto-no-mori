// Shared settings: the handful of preferences that belong to the
// account's devices as a group rather than to any one of them (which
// device a project's + creates on). No server holds them. Every device
// keeps its own full copy, and the copies converge by exchanging
// entries over the direct sessions (shared/sharedSettings.ts has the
// merge, renderer/lib/remote/sharedSettingsSync.ts the exchange).
//
// One entry per setting, each carrying the stamp of the write that set
// it, so two copies merge entry by entry with no coordinator: the later
// stamp wins. The document is deliberately open (string keys, scalar
// values) rather than one field per setting, because devices run
// different builds: a copy must carry and forward an entry its build
// has never heard of, or an older device in the middle would strip a
// newer one's settings on the way through.
import { Option, Schema, SchemaGetter } from "effect";

// Bounds that keep a whole document under the direct wire's frame cap
// (MAX_INBOUND_FRAME_BYTES in shared/ipc/socket/frames.ts, 1 MiB),
// since it rides pushes whole: 512 entries of at most 512 + 256
// characters and a stamp come to well under half of it.
const MAX_SHARED_SETTING_KEY_LENGTH = 512;
const MAX_SHARED_SETTING_STRING_LENGTH = 256;
export const MAX_SHARED_SETTING_ENTRIES = 512;
// The last millisecond a Date can name. Far enough under the largest
// safe integer that a stamp can always be outranked by the next one.
const MAX_SHARED_SETTING_STAMP = 8.64e15;

// Null is a cleared setting. The entry stays as a tombstone: dropping
// it would let a copy that still holds the old value hand it back.
export const SharedSettingValueSchema = Schema.Union([
  Schema.String.check(Schema.isMaxLength(MAX_SHARED_SETTING_STRING_LENGTH)),
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
]);
export type SharedSettingValue = typeof SharedSettingValueSchema.Type;

export const SharedSettingEntrySchema = Schema.Struct({
  value: SharedSettingValueSchema,
  // The write's stamp: milliseconds, never below the writing copy's
  // highest stamp plus one (withSharedSetting), so a device with a slow
  // clock still outranks what it has already seen.
  at: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_SHARED_SETTING_STAMP),
  ),
  // The writing device, which breaks a tie between equal stamps the
  // same way on every copy.
  by: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SharedSettingEntry = typeof SharedSettingEntrySchema.Type;

const SharedSettingKeySchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(MAX_SHARED_SETTING_KEY_LENGTH),
);
const isSharedSettingKey = Schema.is(SharedSettingKeySchema);
const decodeSharedSettingEntry = Schema.decodeUnknownOption(
  SharedSettingEntrySchema,
);

// Read entry by entry: one this build cannot hold (a newer build's
// longer value, a hand-mangled stamp) is left out and the rest still
// merge. Failing the whole document over it would cut this device off
// from every setting a newer peer holds, not just the one it cannot
// read.
//
// Every device runs this exact rule on every copy it takes in, so it
// has to stay the same rule on every build: entries in the document's
// own key order, the first MAX_SHARED_SETTING_ENTRIES readable ones
// kept. A `__proto__` key (JSON.parse makes it an own key) is left out
// like an unreadable entry, as the zod version this replaced left it
// out, and so it can never become the prototype of the entries object.
function readableEntries(raw: {
  readonly [key: string]: unknown;
}): Record<string, SharedSettingEntry> {
  const entries: Record<string, SharedSettingEntry> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_SHARED_SETTING_ENTRIES) break;
    if (key === "__proto__" || !isSharedSettingKey(key)) continue;
    const entry = decodeSharedSettingEntry(value);
    if (Option.isNone(entry)) continue;
    entries[key] = entry.value;
    count += 1;
  }
  return entries;
}

export const SharedSettingsDocSchema = Schema.Struct({
  entries: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.decodeTo(Schema.Record(Schema.String, SharedSettingEntrySchema), {
      decode: SchemaGetter.transform(readableEntries),
      // The kept entries are already a record of unknowns.
      encode: SchemaGetter.transform((entries) => entries),
    }),
  ),
});
export type SharedSettingsDoc = typeof SharedSettingsDocSchema.Type;

export const SetSharedSettingPayloadSchema = Schema.Struct({
  key: SharedSettingKeySchema,
  value: SharedSettingValueSchema,
});

export const MergeSharedSettingsPayloadSchema = Schema.Struct({
  doc: SharedSettingsDocSchema,
});
