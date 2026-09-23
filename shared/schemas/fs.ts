import { Schema } from "effect";

// Filesystem browser used by the Add Project modal. Every call here
// takes the shared PathPayloadSchema.

// Optional copy for the native folder picker. Defaults to the
// "Add a project" wording for backwards compatibility.
export const PickFolderPayloadSchema = Schema.UndefinedOr(
  Schema.Struct({
    title: Schema.optional(Schema.NonEmptyString),
    buttonLabel: Schema.optional(Schema.NonEmptyString),
    // macOS shows this above the file browser (`title` has been ignored
    // on open panels since 10.11). Other platforms ignore it harmlessly.
    message: Schema.optional(Schema.NonEmptyString),
    // Where the panel opens. Defaults to the home folder.
    defaultPath: Schema.optional(Schema.NonEmptyString),
  }),
);
export type PickFolderPayload = typeof PickFolderPayloadSchema.Type;

export const DirectoryEntrySchema = Schema.Struct({
  name: Schema.String,
  isGitRepo: Schema.Boolean,
});

export const DirectoryListingSchema = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(DirectoryEntrySchema),
});

export type DirectoryListing = typeof DirectoryListingSchema.Type;
