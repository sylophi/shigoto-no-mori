import { z } from "zod";
import { invoke } from "@shared/ipc/contract";

// State of the CLI symlink in the user's bin dir:
// - installed: our link, pointing at the binary this app runs
// - stale: our link, pointing at another copy (moved app, other checkout)
// - missing: nothing at the link path
// - foreign: something we didn't create; only replaced when an install
//   passes force (the Settings "Replace and install" consent)
export const CliStatusSchema = z.object({
  // False when there's nothing to link: Windows, or a dev run without a
  // built dist-cli binary. The settings section hides itself then.
  supported: z.boolean(),
  name: z.string(),
  aliasName: z.string(),
  binDir: z.string(),
  linkPath: z.string(),
  state: z.enum(["installed", "stale", "missing", "foreign"]),
  // Every link path whose occupant is foreign, so the replace consent
  // can name each file a force install would overwrite (linkPath only
  // carries the single worst one).
  foreignPaths: z.array(z.string()),
  onPath: z.boolean(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

export const cliContract = {
  status: invoke("cli:status", z.void(), CliStatusSchema),
  install: invoke(
    "cli:install",
    z.object({ force: z.boolean() }),
    CliStatusSchema,
  ),
  uninstall: invoke("cli:uninstall", z.void(), CliStatusSchema),
} as const;

export type CliContract = typeof cliContract;
