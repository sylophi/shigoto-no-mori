import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { DirectoryListingSchema, PathPayloadSchema } from "@shared/schemas";

// Every fs call is remote:true, mutating:true.
// They are reads, but the `mutating` axis is enforced as "gated on the
// command-access switch", and these handlers disclose ARBITRARY
// absolute paths. So instead of waiting for remote path confinement
// they sit behind that switch: while this host does not accept
// commands from its other devices, a peer is refused exactly as for a
// mutation.
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
