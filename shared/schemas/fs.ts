import { z } from "zod";

// Filesystem browser used by the Add Project palette.

export const ListDirectoryPayloadSchema = z.object({
  path: z.string().min(1),
});

export const ScanForGitReposPayloadSchema = z.object({
  path: z.string().min(1),
});

export const IsGitRepoPayloadSchema = z.object({
  path: z.string().min(1),
});

export const FsStatPayloadSchema = z.object({
  path: z.string().min(1),
});

// Optional copy for the native folder picker. Defaults to the
// "Add a project" wording for backwards compatibility.
export const PickFolderPayloadSchema = z
  .object({
    title: z.string().min(1).optional(),
    buttonLabel: z.string().min(1).optional(),
  })
  .optional();

// Slim subset of fs.Stats; "exists: false" means the path is missing or
// unreadable. Used by the carry-over row to render a missing warning and
// pick the right icon (file vs folder).
export const FsStatSchema = z.object({
  exists: z.boolean(),
  isDirectory: z.boolean(),
});
export type FsStat = z.infer<typeof FsStatSchema>;

export const FsListEntriesPayloadSchema = z.object({
  path: z.string().min(1),
});

// Filesystem entry as returned by FsListEntries. Includes dotfiles so the
// carry-over picker can surface .env, .vscode, etc., but skips the special
// .git directory since carrying it over makes no sense.
export const FsEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
});
export const FsListingSchema = z.object({
  path: z.string(),
  entries: z.array(FsEntrySchema),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsListing = z.infer<typeof FsListingSchema>;

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
