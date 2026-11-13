// Starting a batch file (.cmd, .bat), as npm installs a CLI and an
// editor ships its command (`code.cmd`). Windows runs one only through
// cmd.exe, which Node starts as `cmd /d /s /c "<line>"` with the line
// as given, so the line is written here, the one place that quotes for
// cmd.
const BATCH_FILE = /\.(?:bat|cmd)$/i;

// What cmd reads as its own. Each is read as itself after a ^.
const CMD_META = /[()[\]%!^"`<>&|;, *?]/g;

const escaped = (text: string) => text.replace(CMD_META, "^$&");

// An argument as the C runtime reads it back: as it is when it has no
// space or quote, else in quotes, with each quote and the backslashes
// before it, or before the closing one, escaped.
const quoted = (arg: string) =>
  arg !== "" && !/[\s"]/.test(arg)
    ? arg
    : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;

// How to start `program` with `args`: a batch file as cmd's line, its
// arguments escaped twice, since the file hands them on (`%*`) to a
// line cmd reads again. Every quote is escaped too, so cmd never sees
// one open, and a `%` is never a variable. A file that reads an
// argument itself (`%1`) gets it as it is only when nothing in it
// needed escaping.
export const startable = (
  program: string,
  args: ReadonlyArray<string>,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
} =>
  BATCH_FILE.test(program)
    ? {
        command: [
          escaped(program),
          ...args.map((arg) => escaped(escaped(quoted(arg)))),
        ].join(" "),
        args: [],
        shell: true,
      }
    : { command: program, args, shell: false };
