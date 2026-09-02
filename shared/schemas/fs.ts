import { z } from "zod";

// Filesystem browser used by the Add Project modal. Every call here
// takes the shared PathPayloadSchema.

// Optional copy for the native folder picker. Defaults to the
// "Add a project" wording for backwards compatibility.
export const PickFolderPayloadSchema = z
  .object({
    title: z.string().min(1).optional(),
    buttonLabel: z.string().min(1).optional(),
    // macOS shows this above the file browser (`title` has been ignored
    // on open panels since 10.11). Other platforms ignore it harmlessly.
    message: z.string().min(1).optional(),
  })
  .optional();
export type PickFolderPayload = z.infer<typeof PickFolderPayloadSchema>;

export const DirectoryEntrySchema = z.object({
  name: z.string(),
  isGitRepo: z.boolean(),
});

export const DirectoryListingSchema = z.object({
  path: z.string(),
  entries: z.array(DirectoryEntrySchema),
});

export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;
