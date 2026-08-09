import { z } from "zod";
import { invoke } from "@shared/ipc/contract";

// State of the CLI symlink in the user's bin dir:
// - installed: our link, pointing at the binary this app runs
// - stale: our link, pointing at another copy (moved app, other checkout)
// - missing: nothing at the link path
// - foreign: something we didn't create; never touched
export const SgmCliStatusSchema = z.object({
  // False when there's nothing to link: Windows, or a dev run without a
  // built dist-cli binary. The settings section hides itself then.
  supported: z.boolean(),
  name: z.string(),
  binDir: z.string(),
  linkPath: z.string(),
  state: z.enum(["installed", "stale", "missing", "foreign"]),
  onPath: z.boolean(),
});
export type SgmCliStatus = z.infer<typeof SgmCliStatusSchema>;

export const sgmCliContract = {
  status: invoke("sgmCli:status", z.void(), SgmCliStatusSchema),
  install: invoke("sgmCli:install", z.void(), SgmCliStatusSchema),
  uninstall: invoke("sgmCli:uninstall", z.void(), SgmCliStatusSchema),
} as const;

export type SgmCliContract = typeof sgmCliContract;
