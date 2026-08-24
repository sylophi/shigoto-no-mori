import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  DirectoryListingSchema,
  FsListingSchema,
  FsStatSchema,
  PathPayloadSchema,
} from "@shared/schemas";

// Every fs call is remote false this slice: the handlers read arbitrary
// absolute paths, and remote path confinement is deferred, so remote fs browsing waits until that lands.
export const fsContract = defineContract("host", {
  listDirectory: invoke(
    "fs:listDirectory",
    PathPayloadSchema,
    DirectoryListingSchema,
    { remote: false },
  ),
  scanForGitRepos: invoke(
    "fs:scanForGitRepos",
    PathPayloadSchema,
    z.array(z.string()),
    { remote: false },
  ),
  isGitRepo: invoke("fs:isGitRepo", PathPayloadSchema, z.boolean(), {
    remote: false,
  }),
  stat: invoke("fs:stat", PathPayloadSchema, FsStatSchema, { remote: false }),
  listEntries: invoke("fs:listEntries", PathPayloadSchema, FsListingSchema, {
    remote: false,
  }),
});
