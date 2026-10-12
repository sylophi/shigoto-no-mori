// The flavor a packaged build is made as, read from SM_FLAVOR in the
// build's environment (the release workflow sets it from the tag, see
// flavorOfVersion): unset is prod. One reading for everything that
// bakes it in (forge.config.ts, vite.node.config.ts and build-cli.mts),
// so a bundle's name, its main process and its `sm` never disagree.
import type { Flavor } from "@shigomori/engine/flavor";

export function buildFlavor(
  env: Record<string, string | undefined>,
): Exclude<Flavor, "dev"> {
  const value = env.SM_FLAVOR?.trim() ?? "";
  if (value === "" || value === "prod") return "prod";
  if (value === "v3") return "v3";
  throw new Error(`SM_FLAVOR is "${value}": a packaged build is prod or v3.`);
}
