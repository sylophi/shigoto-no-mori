// Account identity from the Clerk session token both enroll handlers
// present (main/ipc/modules/account.ts, web/ipc/register.ts).
// A session token is always a JWT whose `sub` claim is the Clerk user
// id, the same value the device hub's verifier keys D1 rows and Durable
// Objects on. The token is never verified here, it is only read so the
// stored credential record carries the account id. The device hub is
// the sole authority on identity (enroll fails there if the token is
// bad). Anything malformed yields "". atob is a global in both node 22
// and browsers, so no Buffer is needed and the one implementation
// serves both runtimes.
export function deriveAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  try {
    // atob wants plain base64: undo the base64url alphabet and repad.
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}
