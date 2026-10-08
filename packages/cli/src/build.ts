// What the build says this binary is: its flavor (prod `sm`, dev
// `smd`) and the version a release stamps, from build.mts.
declare const SM_FLAVOR: "prod" | "dev" | undefined;
declare const SM_VERSION: string | undefined;

export const flavor = typeof SM_FLAVOR === "undefined" ? "dev" : SM_FLAVOR;

export const version = typeof SM_VERSION === "undefined" ? "dev" : SM_VERSION;
