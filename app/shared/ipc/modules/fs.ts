import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { DirectoryListingSchema, PathPayloadSchema } from "@shared/schemas";

// Every fs call is remote:true, mutating:true.
// They are reads, but the `mutating` axis is enforced as "requires the
// command grant", and these handlers disclose ARBITRARY absolute paths,
// which exceeds the read-only mirror's charter. So instead of waiting
// for remote path confinement they ride the per-peer command grant: a
// peer this host has not granted command access is refused, exactly as
// for a mutation.
export const fsContract = defineContract("host", {
  listDirectory: invoke(
    "fs:listDirectory",
    PathPayloadSchema,
    DirectoryListingSchema,
    { remote: true, mutating: true },
  ),
  scanForGitRepos: invoke(
    "fs:scanForGitRepos",
    PathPayloadSchema,
    z.array(z.string()),
    { remote: true, mutating: true },
  ),
  isGitRepo: invoke("fs:isGitRepo", PathPayloadSchema, z.boolean(), {
    remote: true,
    mutating: true,
  }),
});
