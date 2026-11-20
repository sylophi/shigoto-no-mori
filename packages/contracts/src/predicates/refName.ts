// A full ref under refs/ that git's check-ref-format accepts. These
// cross between devices into git argv, and git's own rules already keep
// out what a revision, a refspec or a path would read: starting with
// refs/, none can read as an option either.
const REFUSED = /[\p{Cc} ~^:?*[\\]|\.\.|@\{|\/\/|\/\.|\.lock(\/|$)|[/.]$/u;

export function isFullRefName(ref: string): boolean {
  return ref.startsWith("refs/") && !REFUSED.test(ref);
}
