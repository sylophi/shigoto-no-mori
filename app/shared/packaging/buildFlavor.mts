// The flavor a packaged build is made as, read from SM_FLAVOR in the
// build's environment: unset is prod (what the release workflow
// builds), and a word that is no build's is a test flavor of that name
// (`SM_FLAVOR=lab pnpm package`). One reading
// for everything that bakes it in (forge.config.ts, vite.node.config.ts
// and build-cli.mts), so a bundle's name, its main process and its `sm`
// never disagree.
import { type Flavor, isFlavor } from "@shigomori/engine/flavor";

export function buildFlavor(env: Record<string, string | undefined>): Flavor {
  const value = env.SM_FLAVOR?.trim() ?? "";
  if (value === "") return "prod";
  if (value !== "dev" && isFlavor(value)) return value;
  throw new Error(
    `SM_FLAVOR is "${value}": a packaged build is prod or a test flavor's word (lowercase letters and digits, a letter first).`,
  );
}
