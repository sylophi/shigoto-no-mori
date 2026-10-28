// A terminal's screen, kept by parsing its output as a client does:
// what a client starting over is sent, and what a quit saves. A
// full-screen program draws its frame once and then only what changes
// (Claude Code's prompt and status line), so the output's tail alone
// would leave those out.
import {
  type GridSize,
  TERMINAL_SCROLLBACK,
} from "@shigomori/contracts/schemas";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/headless";
import * as Effect from "effect/Effect";

export type Screen<A> = {
  // Queues `data`, whose `at` the screen shows once it is parsed.
  readonly write: (data: string, at: A) => void;
  // How much of what was written is still to parse.
  readonly behind: () => number;
  // Once what was written is parsed.
  readonly parsed: Effect.Effect<void>;
  // Once what came before, drawn at the old size, is parsed.
  readonly resize: (size: GridSize) => void;
  // The screen as output that draws it, scrollback, modes and all, its
  // size, and the `at` of the last write in it.
  readonly snapshot: Effect.Effect<{
    readonly data: string;
    readonly size: GridSize;
    readonly at: A;
  }>;
  // The main screen and its scrollback, without the modes a program
  // set: what the next start of the shell shows.
  readonly saved: Effect.Effect<string>;
};

// A scroll region set at the end of the output, and its top row.
const REGION_LAST = new RegExp(String.raw`\x1b\[(\d+);\d+r$`);

// A screen of `size` that has parsed `past`, at `at`.
export function makeScreen<A>(size: GridSize, past: string, at: A): Screen<A> {
  const term = new Terminal({
    ...size,
    scrollback: TERMINAL_SCROLLBACK,
    allowProposedApi: true,
  });
  // A client's widths (TerminalView), so the lines come out as it lays
  // them out.
  term.loadAddon(new UnicodeGraphemesAddon());
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  let parsed = at;
  let behind = 0;
  const write = (data: string, next: A) => {
    behind += data.length;
    term.write(data, () => {
      behind -= data.length;
      parsed = next;
    });
  };
  // `read` once all written before is parsed.
  const afterParsed = <B>(read: () => B): Effect.Effect<B> =>
    Effect.callback((resume) => {
      term.write("", () => resume(Effect.succeed(read())));
    });
  write(past, at);
  return {
    write,
    behind: () => behind,
    parsed: afterParsed(() => undefined),
    resize: ({ cols, rows }) => term.write("", () => term.resize(cols, rows)),
    snapshot: afterParsed(() => {
      const data = serializer.serialize();
      // It ends with the scroll region when there is one, which puts the
      // cursor home (the region's top in origin mode).
      const region = REGION_LAST.exec(data)?.[1];
      const { cursorX, cursorY } = term.buffer.active;
      const top = term.modes.originMode ? Number(region) - 1 : 0;
      return {
        data:
          region === undefined
            ? data
            : `${data}\x1b[${cursorY + 1 - top};${cursorX + 1}H`,
        size: { cols: term.cols, rows: term.rows },
        at: parsed,
      };
    }),
    // Up to the cursor's line: the rows below it are blank, and a smaller
    // screen would scroll the lines above away for them.
    saved: afterParsed(() => {
      const { baseY, cursorY } = term.buffer.normal;
      return serializer.serialize({
        range: { start: 0, end: baseY + cursorY },
        excludeAltBuffer: true,
        excludeModes: true,
      });
    }),
  };
}
