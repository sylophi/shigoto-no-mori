// No server holds them: every device keeps a full copy, and the copies
// converge by exchanging entries. Open (string keys, scalar values) on
// purpose: a copy must forward an entry its build has never heard of, or
// an older device in the middle would strip a newer one's settings.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// A whole document rides pushes, so it stays well under the link's
// 32 MiB frame cap. A string holds a project's setup script or its
// launchers as JSON.
const MAX_SHARED_SETTING_KEY_LENGTH = 512;
const MAX_SHARED_SETTING_STRING_LENGTH = 4096;
export const MAX_SHARED_SETTING_ENTRIES = 2048;
// Far enough under the largest safe integer that a stamp can always be
// outranked.
const MAX_SHARED_SETTING_STAMP = 8.64e15;

// Null is a cleared setting, kept as a tombstone: dropping it would let
// a copy still holding the old value hand it back.
export const SharedSettingValueSchema = Schema.Union([
  Schema.String.check(Schema.isMaxLength(MAX_SHARED_SETTING_STRING_LENGTH)),
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
]);
export type SharedSettingValue = typeof SharedSettingValueSchema.Type;

const SharedSettingEntrySchema = Schema.Struct({
  value: SharedSettingValueSchema,
  // Never below the writer's highest stamp plus one, so a slow clock still
  // outranks what it has seen.
  at: Schema.Natural.check(
    Schema.isLessThanOrEqualTo(MAX_SHARED_SETTING_STAMP),
  ),
  // Breaks a tie the same way on every copy.
  by: Schema.String.check(Schema.isBetweenLength(1, 128)),
});
export type SharedSettingEntry = typeof SharedSettingEntrySchema.Type;

const SharedSettingKeySchema = Schema.String.check(
  Schema.isBetweenLength(1, MAX_SHARED_SETTING_KEY_LENGTH),
);

const isSharedSettingKey = Schema.is(SharedSettingKeySchema);
const decodeSharedSettingEntry = Schema.decodeUnknownOption(
  SharedSettingEntrySchema,
);

type SharedSettingEntries = Record<string, SharedSettingEntry>;

// An entry this build can't hold is left out and the rest still merge:
// failing the document would cut this device off from every setting a
// newer peer holds.
function readableEntries(raw: {
  readonly [key: string]: unknown;
}): SharedSettingEntries {
  const entries: SharedSettingEntries = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_SHARED_SETTING_ENTRIES) break;
    if (!isSharedSettingKey(key)) continue;
    const entry = decodeSharedSettingEntry(value);
    if (Option.isNone(entry)) continue;
    entries[key] = entry.value;
    count += 1;
  }
  return entries;
}

export const SharedSettingsDocSchema = Schema.Struct({
  entries: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.declare((value: unknown): value is SharedSettingEntries =>
        Predicate.isObject(value),
      ),
      SchemaTransformation.transform<
        SharedSettingEntries,
        { readonly [key: string]: unknown }
      >({
        decode: readableEntries,
        encode: readableEntries,
      }),
    ),
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
