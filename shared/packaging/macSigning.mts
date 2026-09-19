// One reading of the macOS signing switch for the two build files that
// must agree on it: forge.config.ts (whether to sign and notarize the
// bundle) and vite.node.config.ts (the __SM_SIGNED_MAC_BUILD__ define
// main/index.ts branches its keychain policy on). A packaged build
// that forge signed but main believed unsigned would skip the real
// keychain for nothing, and the reverse would put an ad-hoc bundle on
// the real keychain, which is the prompt storm main/keychain/reset.ts
// describes.
//
// "-" is codesign's ad-hoc identity: a bundle signed with it has the
// per-binary signature the keychain policy exists to keep off the
// real keychain, so it reads as no identity at all.
//
// Like shared/packaging/cliDist.mts: no imports, so plain node scripts
// and the build configs can load it without a loader shim.
export function macSigningIdentity(
  env: Record<string, string | undefined>,
): string | null {
  const value = env.APPLE_SIGNING_IDENTITY?.trim() ?? "";
  return value === "" || value === "-" ? null : value;
}
