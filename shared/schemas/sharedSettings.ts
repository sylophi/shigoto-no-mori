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
import { z } from "zod";

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
export const SharedSettingValueSchema = z.union([
  z.string().max(MAX_SHARED_SETTING_STRING_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type SharedSettingValue = z.infer<typeof SharedSettingValueSchema>;

export const SharedSettingEntrySchema = z.object({
  value: SharedSettingValueSchema,
  // The write's stamp: milliseconds, never below the writing copy's
  // highest stamp plus one (withSharedSetting), so a device with a slow
  // clock still outranks what it has already seen.
  at: z.number().int().nonnegative().max(MAX_SHARED_SETTING_STAMP),
  // The writing device, which breaks a tie between equal stamps the
  // same way on every copy.
  by: z.string().min(1).max(128),
});
export type SharedSettingEntry = z.infer<typeof SharedSettingEntrySchema>;

const SharedSettingKeySchema = z
  .string()
  .min(1)
  .max(MAX_SHARED_SETTING_KEY_LENGTH);

// Read entry by entry: one this build cannot hold (a newer build's
// longer value, a hand-mangled stamp) is left out and the rest still
// merge. Failing the whole document over it would cut this device off
// from every setting a newer peer holds, not just the one it cannot
// read.
export const SharedSettingsDocSchema = z.object({
  entries: z.record(z.string(), z.unknown()).transform((raw) => {
    const entries: Record<string, SharedSettingEntry> = {};
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (count >= MAX_SHARED_SETTING_ENTRIES) break;
      if (!SharedSettingKeySchema.safeParse(key).success) continue;
      const entry = SharedSettingEntrySchema.safeParse(value);
      if (!entry.success) continue;
      entries[key] = entry.data;
      count += 1;
    }
    return entries;
  }),
});
export type SharedSettingsDoc = z.infer<typeof SharedSettingsDocSchema>;

export const SetSharedSettingPayloadSchema = z.object({
  key: SharedSettingKeySchema,
  value: SharedSettingValueSchema,
});

export const MergeSharedSettingsPayloadSchema = z.object({
  doc: SharedSettingsDocSchema,
});
