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
