import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useScriptRuns } from "@/hooks/scripts/useScriptRuns";
import { openExternalUrl } from "@/lib/openExternal";
import type { ScriptKey, ScriptRunState } from "@/store/scriptRuns";
import { readTerminalTheme, sameTheme } from "./terminalTheme";
import { ConsoleBodyView, ConsoleTerminalView } from "./ScriptConsoleView";

// Refits during a window drag are coalesced to this. The first fit of
// a terminal runs at once so it never paints at xterm's default grid.
const REFIT_DEBOUNCE_MS = 50;

// DECTCEM: terminal cursor visibility.
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

interface ConsoleBodyProps {
  // Where keystrokes and viewport size go. The store ignores both
  // unless the run is live and interactive.
  runKey: ScriptKey;
  state: ScriptRunState;
  onClear: (() => void) | null;
}

export function ConsoleBody({ runKey, state, onClear }: ConsoleBodyProps) {
  return (
    <ConsoleBodyView
      idle={state.status === "idle"}
      starting={state.status === "starting" && !state.hasOutput}
      onClear={onClear}
    >
      <ConsoleTerminal
        key={`${runKey}:${state.startedAt ?? 0}`}
        runKey={runKey}
        state={state}
      />
    </ConsoleBodyView>
  );
}

// One xterm instance per run (keyed on the run key and start time by
// the parent, so a rerun or another script mounts a fresh one). Xterm
// applies writes asynchronously, so reusing a terminal across runs
// would let the old run's queued tail paint over the new one. It is
// a real terminal, not a log view: the run's output is replayed into
// it byte for byte (so cursor movement, progress bars and full-screen
// programs render as they would in Terminal.app), keystrokes go back
// to the PTY while the run is live, and the PTY is told the viewport
// size so programs lay out for the space they have.
function ConsoleTerminal({ runKey, state }: Omit<ConsoleBodyProps, "onClear">) {
  // The scoped device's store: the log the terminal replays and the
  // PTY its keystrokes reach both live on whichever device this
  // console is scoped to. One per device for the window's lifetime, so
  // it is a stable effect dependency.
  const scriptRuns = useScriptRuns();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Whether the grid has been fitted to the host yet. Until then
  // term.cols/rows are xterm's defaults and not worth telling the PTY.
  const fittedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
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
    term.loadAddon(new WebLinksAddon((_event, uri) => openExternalUrl(uri)));
    term.open(host);
    // Keystrokes reach the PTY only once the replay below has been
    // parsed. Recorded output can hold terminal queries (the OSC 10/11/12
    // colour queries, DA, DSR, XTWINOPS), which xterm answers through
    // onData, and on a live interactive run reopened here that answer
    // would go to the PTY as if it were typed: the program that asked
    // has moved on, so its reply lands as input into whatever it is
    // doing now. onData cannot tell a query reply from a keystroke, so
    // the only way to hold the replies back is to hold everything back
    // for the sub-second the replay takes to parse. Keystrokes typed in
    // that window are dropped, which is the accepted price.
    let replayed = false;
    const dataSub = term.onData((data) => {
      if (replayed) scriptRuns.write(runKey, data);
    });
    const resizeSub = term.onResize(({ cols, rows }) =>
      scriptRuns.resize(runKey, cols, rows),
    );
    // Catch up on the run so far in one write, then follow the log. The
    // two happen in the same tick, so nothing is missed or doubled, and
    // live chunks queue behind the replay in xterm's write FIFO, so a
    // query the program sends now is still answered once the gate opens.
    const history = scriptRuns.readOutput(runKey).join("");
    if (history) {
      term.write(history, () => {
        replayed = true;
      });
    } else {
      replayed = true;
    }
    const unsubscribeOutput = scriptRuns.subscribeOutput(runKey, (chunk) =>
      term.write(chunk),
    );
    termRef.current = term;
    fittedRef.current = false;

    // fit() throws while the host has no layout yet (route transition),
    // and the observer fires again once it does. The first successful fit
    // also tells the PTY the size, since xterm only reports resizes
    // that change the grid and the real size may equal its default.
    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (!fittedRef.current) {
        fittedRef.current = true;
        scriptRuns.resize(runKey, term.cols, term.rows);
      }
    };
    let refitTimer: ReturnType<typeof setTimeout> | null = null;
    const refit = () => {
      if (!fittedRef.current) {
        fitNow();
        return;
      }
      if (refitTimer) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => {
        refitTimer = null;
        fitNow();
      }, REFIT_DEBOUNCE_MS);
    };
    // Observing delivers the current size straight away, which is the
    // initial fit. A fit measured before the monospace face has loaded
    // gets the cell width wrong, so measure again once fonts settle.
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    void document.fonts.ready.then(refit);

    // Theme classes and the palette attribute live on <html> and flip
    // after this component's own effects run, so watch the DOM rather
    // than the theme hooks.
    // Only a changed palette is handed to xterm: it repaints everything
    // for any new theme object.
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

    return () => {
      if (refitTimer) clearTimeout(refitTimer);
      unsubscribeOutput();
      themeObserver.disconnect();
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [runKey, scriptRuns]);

  // Typing only makes sense into a live PTY. On the run, take focus so
  // the user can type straight away, and tell the PTY the viewport size
  // once the grid is fitted (xterm's onResize only fires when the grid
  // changes, which it doesn't for a run started into an already-open
  // console). Off it, xterm stops emitting onData (so no stray
  // keystrokes hit the next run), the cursor is hidden since there is
  // nothing to type into, and focus is handed back: a terminal holding
  // it would keep swallowing Tab and keep the app's bare-key shortcuts
  // inert. The cursor writes queue behind the replay above, so they
  // land after it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const live = state.status === "running" && state.interactive;
    term.options.disableStdin = !live;
    term.write(live ? SHOW_CURSOR : HIDE_CURSOR);
    if (live) {
      term.focus();
      if (fittedRef.current) scriptRuns.resize(runKey, term.cols, term.rows);
    } else if (hostRef.current?.contains(document.activeElement)) {
      term.blur();
    }
  }, [runKey, scriptRuns, state.status, state.interactive]);

  return <ConsoleTerminalView hostRef={hostRef} />;
}
