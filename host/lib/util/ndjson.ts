// A newline-delimited stream reader for the NDJSON channels still read
// from a Node 'data' listener (the file-sync daemon's control channel,
// the control server's CLI connections): buffers partial chunks, hands
// each complete line over trimmed, and skips empty ones. The CLI
// runner's document runs read theirs as an Effect Stream instead
// (main/electron/cliRunner.ts), which is where these go as their
// owners convert.
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
