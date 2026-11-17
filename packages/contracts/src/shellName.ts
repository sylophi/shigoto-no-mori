// A shell kind as people read it.
export const shellName = (kind: string): string =>
  kind === "powershell" ? "PowerShell" : kind;
