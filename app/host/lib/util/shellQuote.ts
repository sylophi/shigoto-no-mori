// Quote one argument for a POSIX shell (sh single-quoting): the
// scripts' login shell (host/lib/scripts/pty.ts) and the commands built
// for it.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
