// Reads a required value flag off process.argv in the preload. Main
// hands the device id and app version to the sandboxed preload through
// webPreferences.additionalArguments, and each must be present: a
// missing or empty value means main and preload disagree on the flag,
// so fail loudly rather than run with keys scoped to nothing or an
// empty version on the wire. `flag` is the constant with its trailing
// "=", `name` is the human-facing flag name for the error.
export function requireArgFlag(flag: string, name: string): string {
  const arg = process.argv.find((entry) => entry.startsWith(flag));
  const value = arg?.slice(flag.length) ?? "";
  if (!value) {
    throw new Error(`preload started without ${name}`);
  }
  return value;
}
