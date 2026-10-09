// The selection menu behind every picker, on stderr so a command's
// result (stdout) stays clean: `cd "$(sm path)"` opens it and still
// cds. Its callers ask only a person at a terminal (`interactive`).
import * as Effect from "effect/Effect";
import { Cancelled } from "./errors.ts";
import { alignRows, note, Output, styles } from "./output.ts";

export type Menu = {
  readonly title: string;
  // The column titles, aligned with the rows' cells.
  readonly header?: ReadonlyArray<string>;
  readonly cells: ReadonlyArray<ReadonlyArray<string>>;
  // Each row's name: what `/` and the prompt match, and the echo.
  readonly names: ReadonlyArray<string>;
  // The row highlighted first.
  readonly initial?: number;
};

// The selected row's background: a gray one step off the terminal's,
// light where COLORFGBG says the background is.
const bar = () => {
  const background = Number(process.env.COLORFGBG?.split(";").at(-1));
  return background === 7 || background === 15 ? "48;5;254" : "48;5;237";
};

// The index of the row picked. A cancel fails with Cancelled.
export const select = (menu: Menu) =>
  Effect.gen(function* () {
    const { stderrColor } = yield* Effect.service(Output);
    const paint = styles(stderrColor);
    const lines = alignRows(
      menu.header === undefined ? menu.cells : [menu.header, ...menu.cells],
    );
    const header = menu.header === undefined ? "" : (lines[0] ?? "");
    const rows = menu.header === undefined ? lines : lines.slice(1);
    const { showMenu } = yield* Effect.promise(() => import("./menuView.ts"));
    const choice = yield* Effect.promise(() =>
      showMenu({
        title: menu.title,
        header,
        rows,
        names: menu.names,
        initial: menu.initial ?? 0,
        paint,
        bar: stderrColor ? bar() : "",
      }),
    );
    if (choice === undefined) return yield* new Cancelled();
    yield* note(
      `${paint.dim(menu.title)} ${paint.cyan(menu.names[choice] ?? "")}`,
    );
    return choice;
  });
