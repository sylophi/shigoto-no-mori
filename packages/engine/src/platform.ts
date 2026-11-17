// The OS this process runs on, the one place anything reads it. The
// no-process-platform lint rule keeps process.platform and
// os.platform() out of everywhere else. The Go helpers pick theirs by
// file name (nativefs/sys_<os>.go).
//
// A service whose verbs all differ by OS gives each OS a module of its
// own behind one name, and picks one once (Shells, ProcessTable,
// ProcessTrees, Open's Desktop, the updater's Installation, the
// command line tool's placement). A difference of one value or one call
// stays where it is used, as a table every OS is placed in: byFamily
// when macOS and Linux agree, byPlatform when they don't. So a new OS
// is a type error at each place that differs, and a three-way table
// says macOS and Linux really differ there. A step only a Mac takes
// asks current(), and one that differs by the machine's role asks
// byHostKind.
//
// Code that can't ask the OS (the renderer, packages/ui,
// packages/contracts, the web client) decides from what the host sent
// (a path's spelling, a terminal's syntax, the sidebar's side, a
// mirror's checkout settings) or from the viewer's own machine
// (viewerOs). What crosses devices, such as a worktree's folder name or
// a relative path in a synced config, follows one rule on every OS, in
// the contracts or the sync engine. What stays on this machine branches
// here, so macOS and Linux keep what they did.
export type Platform = "darwin" | "linux" | "win32";

// Read when first asked, so a module that only imports this loads in a
// browser too.
export const current = (): Platform => {
  const os = process.platform;
  if (os !== "darwin" && os !== "linux" && os !== "win32") {
    throw new Error(
      `Shigoto no Mori runs on macOS, Linux and Windows, not ${os}.`,
    );
  }
  return os;
};

// The case for this OS, typed as any of them.
export const byPlatform = <Cases extends { readonly [P in Platform]: unknown }>(
  cases: Cases,
): Cases[Platform] => cases[current()];

type Family = "posix" | "windows";

const FAMILIES: { readonly [P in Platform]: Family } = {
  darwin: "posix",
  linux: "posix",
  win32: "windows",
};

// The case for this OS's family, typed as either.
export const byFamily = <Cases extends { readonly [F in Family]: unknown }>(
  cases: Cases,
): Cases[Family] => cases[FAMILIES[current()]];

// What hosts this machine: the desktop app, or a host run headless as a
// service. Code that differs by that, not by the OS itself, picks its
// case by host kind (byHostKind).
type HostKind = "app" | "headless";

const HOST_KINDS: { readonly [P in Platform]: HostKind } = {
  darwin: "app",
  linux: "headless",
  win32: "app",
};

export const hostKind = (): HostKind => HOST_KINDS[current()];

// The case for this host kind, typed as any of them.
export const byHostKind = <Cases extends { readonly [K in HostKind]: unknown }>(
  cases: Cases,
): Cases[HostKind] => cases[hostKind()];
