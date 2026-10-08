import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { ReleaseSchema, VoidSchema } from "../schemas/index.ts";

// The app's published releases, newest first as GitHub lists them,
// for the changelog. A CLIENT module: the release list is the same
// for every device, so the window fetches it through its own binding
// (shared/releases.ts) and measures each device's version against it.
export const releasesContract = defineContract("client", {
  list: invoke("releases:list", VoidSchema, Schema.Array(ReleaseSchema)),
});
