// The process's log files. A launch from Finder or the Dock has no
// terminal, so the console (where the app's logger writes, see
// shared/log.ts) goes to ~/Library/Logs/<app name>/main.log as well,
// rotated to main.old.log past 1 MB, and every span that ends goes to
// trace.log beside it (host/lib/util/observability.ts). A dev build's renamed
// app (`Shigoto no Mori (Dev)`, plus its profile) keeps its own folder.
// The terminal still gets each console line as it was written.
import log from "electron-log/main";

const trace = log.create({ logId: "trace" });

// After app.setName: the folder is named on the first write.
export function captureConsoleToFile(): void {
  log.transports.console.format = "{text}";
  Object.assign(console, log.functions);
  trace.transports.console.level = false;
  trace.transports.ipc.level = false;
  trace.transports.file.fileName = "trace.log";
  trace.transports.file.format = "{text}";
}

export function writeTraceLine(line: string): void {
  trace.info(line);
}
