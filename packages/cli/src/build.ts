// What the build says this binary is: its flavor (prod `sm`, dev
// `smd`), from build.mts, and its version, which only a release build
// will set.
declare const SM_FLAVOR: "prod" | "dev" | undefined;

export const flavor = typeof SM_FLAVOR === "undefined" ? "dev" : SM_FLAVOR;

export const version = "dev";
