import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  DirectoryListingSchema,
  FsListingSchema,
  FsStatSchema,
  PathPayloadSchema,
} from "@shared/schemas";

export const fsContract = {
  listDirectory: invoke(
    "fs:listDirectory",
    PathPayloadSchema,
    DirectoryListingSchema,
  ),
  scanForGitRepos: invoke(
    "fs:scanForGitRepos",
    PathPayloadSchema,
    z.array(z.string()),
  ),
  isGitRepo: invoke("fs:isGitRepo", PathPayloadSchema, z.boolean()),
  stat: invoke("fs:stat", PathPayloadSchema, FsStatSchema),
  listEntries: invoke("fs:listEntries", PathPayloadSchema, FsListingSchema),
} as const;

export type FsContract = typeof fsContract;
