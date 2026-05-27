import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  DirectoryListingSchema,
  FsListEntriesPayloadSchema,
  FsListingSchema,
  FsStatPayloadSchema,
  FsStatSchema,
  IsGitRepoPayloadSchema,
  ListDirectoryPayloadSchema,
  ScanForGitReposPayloadSchema,
} from "@shared/schemas";

export const fsContract = {
  listDirectory: invoke(
    "fs:listDirectory",
    ListDirectoryPayloadSchema,
    DirectoryListingSchema,
  ),
  scanForGitRepos: invoke(
    "fs:scanForGitRepos",
    ScanForGitReposPayloadSchema,
    z.array(z.string()),
  ),
  isGitRepo: invoke("fs:isGitRepo", IsGitRepoPayloadSchema, z.boolean()),
  stat: invoke("fs:stat", FsStatPayloadSchema, FsStatSchema),
  listEntries: invoke(
    "fs:listEntries",
    FsListEntriesPayloadSchema,
    FsListingSchema,
  ),
} as const;

export type FsContract = typeof fsContract;
