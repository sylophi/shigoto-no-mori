import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import { DirectoryListingSchema, PathPayloadSchema } from "@shared/schemas";

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
} as const;
