// Best-effort account identity from the OAuth token, shared by the
// desktop login (main/account/login.ts) and the browser login
// (web/account/login.ts). When the token is a JWT (three base64url
// segments) its `sub` claim names the account, which makes a friendlier
// signed-in display. Anything else, including an opaque non-JWT token,
// yields "" and the UI falls back to the device list. The token is never
// verified here, it is only read for display, and the relay is the sole
// authority on identity. atob is a global in both node 22 and browsers
// (the same portability argument pkce.ts makes for btoa), so no Buffer
// is needed and the one implementation serves both runtimes.
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
