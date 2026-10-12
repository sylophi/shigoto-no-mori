import type { RendererApi } from "@/lib/runtime/pageApi";
import { notifyError } from "@/lib/toast";

// Opens a web URL in the system browser through the scheme-validated
// shell IPC (renderer windows never navigate), reporting failure as a
// toast. The one policy behind every clickable URL in the app.
export function openExternalUrl(
  api: Pick<RendererApi, "shell">,
  url: string,
  errorTitle = "Couldn't open link",
): void {
  api.shell.openExternal({ url }).catch((err) => notifyError(errorTitle, err));
}

// Shows a local path in the system file manager, the same way: through
// the shell IPC, reporting failure as a toast.
export function revealInFolder(
  api: Pick<RendererApi, "shell">,
  path: string,
  errorTitle: string,
): void {
  api.shell
    .showItemInFolder({ path })
    .catch((err: unknown) => notifyError(errorTitle, err));
}
