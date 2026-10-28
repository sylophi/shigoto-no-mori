// The OS this process runs on, the one place anything reads it. Code
// that differs by OS picks its case from a table naming every OS the
// app runs on (byPlatform), so a new one is a type error at each place
// that differs, and a step only a Mac takes asks current(). The
// no-process-platform lint rule keeps process.platform and
// os.platform() out of everywhere else. The Go
// helpers pick theirs by file name (nativefs/sys_<os>.go).
export type Platform = "darwin" | "linux";

// Read when first asked, so a module that only imports this loads in a
// browser too.
export const current = (): Platform => {
  const os = process.platform;
  if (os !== "darwin" && os !== "linux") {
    throw new Error(`Shigoto no Mori runs on macOS and Linux, not ${os}.`);
  }
  return os;
};

// The case for this OS, typed as any of them.
export const byPlatform = <Cases extends { readonly [P in Platform]: unknown }>(
  cases: Cases,
): Cases[Platform] => cases[current()];
