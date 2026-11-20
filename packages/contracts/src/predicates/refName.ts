// What git's check-ref-format accepts under refs/. Refs cross between
// devices into git argv: git's rules keep out what a revision or a
// refspec would read, and starting with refs/, none reads as an option.
const REFUSED = /[\p{Cc} ~^:?*[\\]|\.\.|@\{|\/\/|\/\.|\.lock(\/|$)|[/.]$/u;

export function isFullRefName(ref: string): boolean {
  return ref.startsWith("refs/") && !REFUSED.test(ref);
}
