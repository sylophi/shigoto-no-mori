// Main-process console output, also written to a file. A launch from
// Finder or the Dock has no terminal, so without this every console
// call in main, host and shared goes nowhere. The file is
// ~/Library/Logs/<app name>/main.log, rotated to main.old.log past
// 1 MB; a dev build's renamed app (`Shigoto no Mori (Dev)`, plus its
// profile) keeps its own folder. The terminal still gets each line as
// it was written.
import log from "electron-log/main";

// After app.setName: the folder is named on the first write.
export function captureConsoleToFile(): void {
  log.transports.console.format = "{text}";
  Object.assign(console, log.functions);
}
