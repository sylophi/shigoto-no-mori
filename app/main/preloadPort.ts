// The preload's one message with main: asking for the page's shell port
// (main/ipc/shellLink.ts, installShellPorts) and handing it on to the
// page, which a context bridge cannot carry a port across.
import { ipcRenderer } from "electron";
import { SHELL_PORT_CHANNEL } from "@shared/ipc/shell";

export function requestShellPort(): void {
  ipcRenderer.once(SHELL_PORT_CHANNEL, (event) => {
    window.postMessage(SHELL_PORT_CHANNEL, "*", [...event.ports]);
  });
  ipcRenderer.send(SHELL_PORT_CHANNEL);
}
