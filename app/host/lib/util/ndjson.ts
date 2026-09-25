// One newline-delimited stream reader for every child the app speaks
// NDJSON with (the CLI runner's document runs, the file-sync daemon's
// control channel, the checks' CLI seam): buffers partial chunks,
// hands each complete line over trimmed, and skips empty ones.
export function lineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (
      let newline = buffer.indexOf("\n");
      newline >= 0;
      newline = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") onLine(line);
    }
  };
}
