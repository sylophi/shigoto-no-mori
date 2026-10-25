// A terminal on screen: xterm drawing on the GPU, fed by its container.
// The size is the host's (every client attached draws at it), so the
// view only says what grid it has room for (onFit), once a change of its
// box settles and whenever it takes focus, and draws at whatever size the
// feed sets. A grid bigger than the box is cut off at its edges.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { usersAlone } from "../../lib/usersAlone.ts";
import { readTerminalTheme, sameTheme } from "./terminalTheme.ts";

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

// The theme's mono weight (doubutsu sets 550), which xterm takes as a
// number.
const fontWeightOf = (host: HTMLElement): number =>
  Number(host.ownerDocument.defaultView?.getComputedStyle(host).fontWeight) ||
  400;

// The host's size on the type scale, larger on a phone, in pixels.
const fontSizeOf = (host: HTMLElement): number =>
  Number.parseFloat(
    host.ownerDocument.defaultView?.getComputedStyle(host).fontSize ?? "",
  ) || 11;

// How long the box stays put before its new size goes to the shell. A
// shell redraws its prompt at each size it is told, and a narrower grid
// reflows the prompt it redraws over, which leaves a copy above (zsh's
// multi-line themes), so a drag tells it only the size it ends at.
const SETTLE_MS = 150;

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
  // Proposes the host's size to the process (`claim`: even unchanged).
  const proposeRef = useRef<((claim: boolean) => void) | null>(null);
  // The latest callbacks, so a new closure from the container does not
  // build a new terminal.
  const input = useEffectEvent(onInput);
  const fitTo = useEffectEvent(onFit);
  const link = useEffectEvent(onLink);

  // xterm keeps every glyph it has drawn, so it opens once both faces
  // are in: one drawn in the fallback face would stay that way. A Nerd
  // Font icon is what loads the symbols face.
  const [fontsIn, setFontsIn] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const doc = host.ownerDocument;
    const family = doc.defaultView?.getComputedStyle(host).fontFamily ?? "";
    void doc.fonts
      .load(`${fontSizeOf(host)}px ${family}`, "a\ue0b0")
      .catch(() => {})
      .then(() => {
        if (!cancelled) setFontsIn(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !feed || !fontsIn) return;
    let theme = readTerminalTheme(host);
    const term = new Terminal({
      // The host's `font-terminal text-2xs` and the theme's mono weight,
      // handed to xterm, which sizes its cell grid from them rather than
      // from CSS. No extra line height: the face's own line box has the
      // leading.
      fontFamily:
        host.ownerDocument.defaultView?.getComputedStyle(host).fontFamily,
      fontWeight: fontWeightOf(host),
      fontSize: fontSizeOf(host),
      lineHeight: 1,
      cursorBlink: true,
      scrollback: 5_000,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => link(uri)));
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
      if (replayed && host.contains(host.ownerDocument.activeElement)) {
        input(data);
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
      fitTo(cols, rows);
    };
    proposeRef.current = propose;
    // Observing delivers the current size straight away, which goes at
    // once: the shell starts at the host's default size.
    let settling: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(settling);
      if (proposed === "") propose(false);
      else settling = setTimeout(() => propose(false), SETTLE_MS);
    });
    observer.observe(host);
    // Taking focus takes the size: the last terminal typed in decides it.
    const onFocus = () => propose(true);
    term.textarea?.addEventListener("focus", onFocus);

    // Theme classes and the palette attribute live on the window's theme
    // root and flip after this component's own effects run, so watch the
    // DOM rather than the theme hooks. Only a changed palette is handed to xterm:
    // it repaints everything for any new theme object.
    const themeObserver = new MutationObserver(() => {
      const weight = fontWeightOf(host);
      if (term.options.fontWeight !== weight) term.options.fontWeight = weight;
      const next = readTerminalTheme(host);
      if (sameTheme(theme, next)) return;
      theme = next;
      term.options.theme = next;
    });
    const themeRoot = host.closest("[data-theme-scope]");
    if (themeRoot)
      themeObserver.observe(themeRoot, {
        attributes: true,
        attributeFilter: ["class", "data-palette"],
      });

    const stop = feed({
      replay: (data, reset) => {
        if (reset) {
          term.reset();
          // A shell the host started again (its restart) starts at the
          // host's default size, and this view, holding focus through
          // it, takes no focus event to claim its own.
          if (host.contains(host.ownerDocument.activeElement)) propose(true);
        }
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
      clearTimeout(settling);
      term.textarea?.removeEventListener("focus", onFocus);
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
      proposeRef.current = null;
    };
  }, [feed, fontsIn]);

  // An exited shell takes no keystrokes: the cursor goes, and focus is
  // handed back, so Tab and the app's bare-key shortcuts work again. One
  // that comes alive (a script's run past its start) claims its size,
  // which its process could not take before it ran, and takes focus
  // unless something else on the page holds it (a field typed in
  // meanwhile). Applied again to a terminal built anew for a new feed.
  const wasLive = useRef(live);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !live;
    term.write(live ? SHOW_CURSOR : HIDE_CURSOR);
    const host = hostRef.current;
    if (!live && host?.contains(host.ownerDocument.activeElement)) {
      term.blur();
    }
    if (live && !wasLive.current) {
      proposeRef.current?.(true);
      const document = host?.ownerDocument;
      const active = document?.activeElement;
      const drawer = host?.closest("[data-slot=terminal-drawer]");
      if (
        active == null ||
        active === document?.body ||
        drawer?.contains(active) === true
      ) {
        term.focus();
      }
    }
    wasLive.current = live;
  }, [live, fontsIn, feed]);

  // Padding lives on the wrapper: the fit addon sizes the grid from the
  // host's box, so padding on the host itself would count as columns.
  // `isolate` keeps xterm's z-indexes from competing with the drawer's
  // controls, and its viewport's black lets the background through.
  return (
    <div
      data-slot="terminal"
      data-keyboard-surface="raw"
      {...usersAlone("terminal")}
      className="isolate h-full w-full overflow-hidden bg-card px-3 py-1 font-terminal text-2xs"
    >
      <div
        ref={hostRef}
        className="h-full w-full overflow-hidden [&_.xterm-viewport]:bg-transparent"
      />
    </div>
  );
}
