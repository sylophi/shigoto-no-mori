import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { DirectoryListingSchema, PathPayloadSchema } from "@shared/schemas";

// Every fs call is remote:true, gated:true.
// They are reads, but the `gated` axis is enforced as "gated on the
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
    { remote: true, gated: true },
  ),
  scanForGitRepos: invoke(
    "fs:scanForGitRepos",
    PathPayloadSchema,
    z.array(z.string()),
    { remote: true, gated: true },
  ),
  isGitRepo: invoke("fs:isGitRepo", PathPayloadSchema, z.boolean(), {
    remote: true,
    gated: true,
  }),
});
