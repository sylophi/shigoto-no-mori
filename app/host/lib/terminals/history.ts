// A terminal's history: its last output chunks, each with its seq, up
// to a cap on their length. What an attach replays, and what a quit
// saves.

// A terminal query: the program asks the terminal something and reads
// the answer as input. Replayed into a terminal again, the terminal
// answers again, into whatever the program is doing now, so the
// history keeps none. Device attributes (DA1, DA2, DA3), status and
// cursor reports (DSR, CPR), mode and setting requests (DECRQM,
// DECRQSS, XTGETTCAP, XTVERSION, the kitty keyboard flags), the window
// reports (XTWINOPS 11, 13, 14, 16, 18, 19, 20, 21), and the OSC
// colour, palette and clipboard queries.
const QUERIES = new RegExp(
  [
    String.raw`\x1b\[[>=]?0?c`,
    String.raw`\x1b\[\??[56]n`,
    String.raw`\x1b\[\??\d+\$p`,
    String.raw`\x1b\[(?:1[134689]|2[01])t`,
    String.raw`\x1b\[>0?q`,
    String.raw`\x1b\[\?u`,
    String.raw`\x1bP[$+]q[^\x1b\x07]*(?:\x1b\\|\x07)`,
    String.raw`\x1b\](?:1[0-9]|4;\d+|52;[a-z]*);\?(?:\x1b\\|\x07)`,
  ].join("|"),
  "g",
);

export const withoutQueries = (data: string): string =>
  data.replace(QUERIES, "");

// How much output a terminal keeps, in UTF-16 code units: a few
// screens of a full-screen program's redraws, or thousands of lines of
// a log.
const HISTORY_LIMIT = 512 * 1024;

type Chunk = { readonly seq: number; readonly data: string };

export type History = {
  // Keeps a chunk of output, without its queries.
  readonly append: (seq: number, data: string) => void;
  // What came after `after`, joined, ending at the last chunk's seq.
  // `reset` when the ring no longer holds all of it (or `after` is
  // absent): `data` is then everything it holds.
  readonly since: (after: number | undefined) => {
    readonly data: string;
    readonly seq: number;
    readonly reset: boolean;
  };
  readonly text: () => string;
};

// A ring starting after `seq`, holding `text` as that chunk when given
// (a restored terminal's saved history).
export function makeHistory(
  seq: number,
  text = "",
  limit = HISTORY_LIMIT,
): History {
  const chunks: Chunk[] = [];
  let length = 0;
  // The seq of the last chunk dropped off the front, or the start's.
  let dropped = seq;
  let last = seq;
  const append = (at: number, data: string) => {
    last = at;
    const kept = withoutQueries(data);
    if (kept.length === 0) return;
    chunks.push({ seq: at, data: kept });
    length += kept.length;
    // The newest chunk stays whatever its size.
    while (length > limit && chunks.length > 1) {
      const first = chunks.shift();
      if (first === undefined) break;
      length -= first.data.length;
      dropped = first.seq;
    }
  };
  if (text.length > 0) {
    chunks.push({ seq, data: text });
    length = text.length;
    dropped = seq - 1;
  }
  return {
    append,
    since: (after) => {
      const reset = after === undefined || after < dropped || after > last;
      const from = reset ? dropped : after;
      return {
        data: chunks
          .filter((chunk) => chunk.seq > from)
          .map((chunk) => chunk.data)
          .join(""),
        seq: last,
        reset,
      };
    },
    text: () => chunks.map((chunk) => chunk.data).join(""),
  };
}
