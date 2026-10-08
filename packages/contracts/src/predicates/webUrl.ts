// Single definition of "URL safe to hand to the OS". Only web URLs may
// be opened externally: file:, javascript:, and custom app schemes
// could launch local apps or files from a crafted href. Used by both
// the shell:openExternal IPC schema and the native context menu so the
// two allow-lists can't drift.
export function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
