// The login shell a script or a terminal runs in.
import { userInfo } from "node:os";
import { envSetting } from "@shared/config";

// $SHELL is reliable when launched from a terminal, but can be empty in
// GUI launches depending on launchd state. os.userInfo().shell reads the
// passwd entry directly. We use a *login* shell (no `-i`) so the user's
// `.zprofile` / `.bash_profile` runs without zsh's interactive-init code
// (job control, prompt setup, zle) getting in the way of the command.
// Given no command (a terminal's), the shell is interactive anyway,
// since its input is a terminal.
export function resolveShell(): { command: string; args: string[] } {
  const userShell = envSetting("SHELL") || userInfo().shell;
  if (userShell) return { command: userShell, args: ["-l"] };
  return { command: "/bin/sh", args: [] };
}
