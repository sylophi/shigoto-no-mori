import { notifyError } from "@/lib/toast";

// Opens a web URL in the system browser through the scheme-validated
// shell IPC (renderer windows never navigate), reporting failure as a
// toast. The one policy behind every clickable URL in the app.
export function openExternalUrl(
  url: string,
  errorTitle = "Couldn't open link",
): void {
  window.api.shell
    .openExternal(url)
    .catch((err) => notifyError(errorTitle, err));
}

// Shows a local path in the system file manager, the same way: through
// the shell IPC, reporting failure as a toast.
export function revealInFolder(path: string, errorTitle: string): void {
  window.api.shell
    .showItemInFolder(path)
    .catch((err: unknown) => notifyError(errorTitle, err));
}
