// A terminal on screen: xterm drawing on the GPU, fed by its container.
// The size is the host's (every client attached draws at it), so the
// view only says what grid it has room for (onFit), on every change of
// its box and whenever it takes focus, and draws at whatever size the
// feed sets. A grid bigger than the box is cut off at its edges.
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { readTerminalTheme, sameTheme } from "./terminalTheme";

// What the feed writes into once the screen is up.
export type TerminalScreen = {
  // The history: everything (`reset`, the screen starts over) or what
  // came since the screen last heard. Keystrokes wait for it to be
  // parsed, since a replayed query would be answered as if typed.
  readonly replay: (data: string, reset: boolean) => void;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
};

// Starts feeding a screen, until the returned stop.
export type TerminalFeed = (screen: TerminalScreen) => () => void;

// DECTCEM: terminal cursor visibility.
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

export function TerminalView({
  feed,
  live,
  onInput,
  onFit,
  onLink,
}: {
  // Null where nothing feeds it (a scene).
  feed: TerminalFeed | null;
  // Whether keystrokes reach a shell: false once it has exited.
  live: boolean;
  onInput: (data: string) => void;
  // The grid the box has room for.
  onFit: (cols: number, rows: number) => void;
  onLink: (uri: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // The latest callbacks, so a new closure from the container does not
  // build a new terminal.
  const handlers = useRef({ onInput, onFit, onLink });
  handlers.current = { onInput, onFit, onLink };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !feed) return;
    let theme = readTerminalTheme(host);
    const term = new Terminal({
      // Matches the host's `font-mono text-xs`. xterm sizes its cell
      // grid from these, so they can't come from CSS.
      fontFamily: getComputedStyle(host).fontFamily,
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5_000,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => handlers.current.onLink(uri)),
    );
    term.open(host);
    // The GPU renderer, for a full-screen program's redraws. A lost
    // context (the GPU reset, too many contexts) falls back to the DOM
    // renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
    termRef.current = term;

    // Keystrokes, and the answers xterm gives a program's queries,
    // reach the shell only from the terminal that holds focus: another
    // client attached to the same shell answers nothing, so a query is
    // answered once. And only once the replay is parsed (TerminalScreen).
    let replayed = true;
    const dataSub = term.onData((data) => {
      if (replayed && host.contains(document.activeElement)) {
        handlers.current.onInput(data);
      }
    });

    let proposed = "";
    const propose = (claim: boolean) => {
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) {
        return;
      }
      const cols = Math.max(2, size.cols);
      const rows = Math.max(1, size.rows);
      const key = `${cols}x${rows}`;
      if (!claim && key === proposed) return;
      proposed = key;
      handlers.current.onFit(cols, rows);
    };
    // Observing delivers the current size straight away. A size measured
    // before the monospace face has loaded gets the cell width wrong, so
    // measure again once fonts settle.
    const observer = new ResizeObserver(() => propose(false));
    observer.observe(host);
    void document.fonts.ready.then(() => propose(false));
    // Taking focus takes the size: the last terminal typed in decides it.
    const onFocus = () => propose(true);
    term.textarea?.addEventListener("focus", onFocus);

    // Theme classes and the palette attribute live on <html> and flip
    // after this component's own effects run, so watch the DOM rather
    // than the theme hooks. Only a changed palette is handed to xterm:
    // it repaints everything for any new theme object.
    const themeObserver = new MutationObserver(() => {
      const next = readTerminalTheme(host);
      if (sameTheme(theme, next)) return;
      theme = next;
      term.options.theme = next;
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-palette"],
    });

    const stop = feed({
      replay: (data, reset) => {
        if (reset) term.reset();
        if (data.length === 0) return;
        replayed = false;
        term.write(data, () => {
          replayed = true;
        });
      },
      write: (data) => term.write(data),
      resize: (cols, rows) => {
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      },
    });
    term.focus();

    return () => {
      stop();
      themeObserver.disconnect();
      observer.disconnect();
      term.textarea?.removeEventListener("focus", onFocus);
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [feed]);

  // An exited shell takes no keystrokes: the cursor goes, and focus is
  // handed back, so Tab and the app's bare-key shortcuts work again.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !live;
    term.write(live ? SHOW_CURSOR : HIDE_CURSOR);
    if (!live && hostRef.current?.contains(document.activeElement)) {
      term.blur();
    }
  }, [live]);

  // Padding lives on the wrapper: the fit addon sizes the grid from the
  // host's box, so padding on the host itself would count as columns.
  // `isolate` keeps xterm's z-indexes from competing with the drawer's
  // controls, and its viewport's black lets the background through.
  return (
    <div
      data-slot="terminal"
      data-keyboard-surface="raw"
      className="isolate h-full w-full overflow-hidden bg-background px-3 py-2 font-mono text-xs"
    >
      <div
        ref={hostRef}
        className="h-full w-full overflow-hidden [&_.xterm-viewport]:bg-transparent"
      />
    </div>
  );
}
