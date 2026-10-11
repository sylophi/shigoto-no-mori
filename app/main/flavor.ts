// The flavor this process runs as, the one place main reads it: a
// packaged build's is baked in when it is built (__SM_PACKAGED_FLAVOR__),
// and a dev run is dev. Everything a flavor names comes from its row in
// the flavor table (packages/engine/src/flavor.ts), and the host is
// handed the flavor with its facts.
import { app } from "electron";
import {
  type Flavor,
  type FlavorNames,
  flavorNames,
} from "@shigomori/engine/flavor";

export const flavor: Flavor = app.isPackaged ? __SM_PACKAGED_FLAVOR__ : "dev";

export const names: FlavorNames = flavorNames(flavor);
