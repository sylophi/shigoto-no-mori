import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { DirectoryListingSchema, PathPayloadSchema } from "../schemas/index.ts";

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
    Schema.Array(Schema.String),
    { remote: true, gated: true },
  ),
  isGitRepo: invoke("fs:isGitRepo", PathPayloadSchema, Schema.Boolean, {
    remote: true,
    gated: true,
  }),
});
