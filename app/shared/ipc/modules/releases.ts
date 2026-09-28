import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { ReleaseSchema } from "@shared/schemas";

// The app's published releases, newest first as GitHub lists them,
// for the changelog. A CLIENT module: the release list is the same
// for every device, so the window fetches it through its own binding
// (shared/releases.ts) and measures each device's version against it.
export const releasesContract = defineContract("client", {
  list: invoke("releases:list", z.void(), z.array(ReleaseSchema)),
});
