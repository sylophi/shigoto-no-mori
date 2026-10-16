import type { Flavor } from "@shigomori/engine/flavor";

// What the build says this binary is: its flavor (prod `sm`, v3
// `smv3`, dev `smd`, a test flavor's `sm<word>`) and the version a
// release stamps, from build.mts.
declare const SM_FLAVOR: Flavor | undefined;
declare const SM_VERSION: string | undefined;

export const flavor = typeof SM_FLAVOR === "undefined" ? "dev" : SM_FLAVOR;

export const version = typeof SM_VERSION === "undefined" ? "dev" : SM_VERSION;
