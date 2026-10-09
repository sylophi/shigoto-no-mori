// The menu's screen, on ink: arrow keys or j/k, `/` to filter by name,
// enter to select, esc or Ctrl-C to cancel, scrolling on long lists.
// Loaded only when a menu shows, so other commands don't pay for React.
import { Box, render, Text, useApp, useInput } from "ink";
import { createElement as h, useEffect, useState } from "react";
import type { Styles } from "./output.ts";

export type MenuProps = {
  readonly title: string;
  readonly header: string;
  readonly rows: ReadonlyArray<string>;
  // What `/` matches, lowercased: the names alone, since cells like
  // "clean" or "local" repeat on every row.
  readonly names: ReadonlyArray<string>;
  readonly initial: number;
  readonly paint: Styles;
  // The selected row's background, or "" to mark it by the arrow alone.
  readonly bar: string;
};

type State = {
  readonly query: string;
  readonly filtering: boolean;
  readonly cursor: number;
  readonly offset: number;
};

const RESET = "\u001b[0m";

// The selected row keeps its cells' colors on a background bar: each
// reset in it puts the bar back, as fzf does.
const onBar = (line: string, bar: string) =>
  bar === ""
    ? line
    : `\u001b[${bar}m${line.replaceAll(RESET, `\u001b[0;${bar}m`)}${RESET}`;

const matching = (names: ReadonlyArray<string>, query: string) => {
  const wanted = query.toLowerCase();
  return names.flatMap((name, index) =>
    wanted === "" || name.toLowerCase().includes(wanted) ? [index] : [],
  );
};

// The rows a terminal of `height` has room for, past the title, the
// help, the filter line, the header and the two clip lines.
const roomFor = (height: number, header: string) =>
  Math.max(height - (header === "" ? 5 : 6), 3);

// The cursor kept on screen.
const scrolled = (state: State, shown: number, room: number): State => {
  const rows = Math.min(room, shown);
  let offset = Math.min(state.offset, state.cursor);
  if (state.cursor >= offset + rows) offset = state.cursor - rows + 1;
  offset = Math.max(0, Math.min(offset, shown - rows));
  return { ...state, offset };
};

function Menu(
  props: MenuProps & { readonly done: (choice: number | undefined) => void },
) {
  const { exit } = useApp();
  const room = roomFor(process.stderr.rows || 24, props.header);
  const [state, setState] = useState<State>(() =>
    scrolled(
      { query: "", filtering: false, cursor: props.initial, offset: 0 },
      props.rows.length,
      room,
    ),
  );
  const [ended, setEnded] = useState(false);
  const visible = matching(props.names, state.query);

  // The last frame is empty, so the menu leaves no trace but the echo.
  useEffect(() => {
    if (ended) exit();
  }, [ended, exit]);

  const end = (choice: number | undefined) => {
    props.done(choice);
    setEnded(true);
  };
  const update = (next: Partial<State>) =>
    setState((now) => {
      const merged = { ...now, ...next };
      const shown = matching(props.names, merged.query).length;
      const cursor = Math.max(0, Math.min(merged.cursor, shown - 1));
      return scrolled({ ...merged, cursor }, shown, room);
    });
  const move = (delta: number) =>
    visible.length > 0 &&
    update({
      cursor: (state.cursor + delta + visible.length) % visible.length,
    });

  useInput((input, key) => {
    if (key.ctrl && input === "c") return end(undefined);
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.return) {
      const choice = visible[state.cursor];
      return choice === undefined ? undefined : end(choice);
    }
    if (key.escape) {
      return state.filtering || state.query !== ""
        ? update({ filtering: false, query: "" })
        : end(undefined);
    }
    if (state.filtering) {
      if (key.backspace || key.delete) {
        return state.query === ""
          ? update({ filtering: false })
          : update({ query: [...state.query].slice(0, -1).join("") });
      }
      if (!key.ctrl && !key.meta && input !== "") {
        return update({ query: state.query + input });
      }
      return;
    }
    if (input === "k") return move(-1);
    if (input === "j") return move(1);
    if (input === "g" || key.home) return update({ cursor: 0 });
    if (input === "G" || key.end) {
      return update({ cursor: visible.length - 1 });
    }
    if (input === "/") update({ filtering: true });
  });

  if (ended) return null;
  const { bold, dim } = props.paint;
  const rows = Math.min(room, visible.length);
  const lines = [bold(props.title)];
  if (state.filtering || state.query !== "") {
    lines.push(`  ${dim("/")}${state.query}`);
  }
  if (props.header !== "") lines.push(`  ${dim(props.header)}`);
  if (state.offset > 0) lines.push(dim(`  ↑ ${state.offset} more`));
  if (visible.length === 0) lines.push(dim("  (no matches)"));
  for (const [at, index] of visible
    .slice(state.offset, state.offset + rows)
    .entries()) {
    const row = props.rows[index] ?? "";
    lines.push(
      state.offset + at === state.cursor
        ? onBar(`▸ ${row}`, props.bar)
        : `  ${row}`,
    );
  }
  const rest = visible.length - state.offset - rows;
  if (rest > 0) lines.push(dim(`  ↓ ${rest} more`));
  lines.push(
    dim(
      state.filtering
        ? "type to filter · enter select · esc clear"
        : "↑/↓ move · / filter · enter select · esc cancel",
    ),
  );
  return h(
    Box,
    { flexDirection: "column" },
    ...lines.map((line, key) => h(Text, { key, wrap: "truncate-end" }, line)),
  );
}

// The index picked, or undefined for a cancel.
export const showMenu = async (props: MenuProps) => {
  let choice: number | undefined;
  const instance = render(
    h(Menu, {
      ...props,
      done: (picked) => {
        choice = picked;
      },
    }),
    { stdout: process.stderr, exitOnCtrlC: false, patchConsole: false },
  );
  await instance.waitUntilExit();
  return choice;
};
