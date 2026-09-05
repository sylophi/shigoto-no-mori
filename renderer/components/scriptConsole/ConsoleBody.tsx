import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Trash2 } from "lucide-react";
import { openExternalUrl } from "@/lib/openExternal";
import {
  type ScriptKey,
  type ScriptRunState,
  scriptRuns,
} from "@/store/scriptRuns";
import { readTerminalTheme, sameTheme } from "./terminalTheme";

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
  if (state.status === "idle") {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No runs yet. Press Run to start.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <ConsoleTerminal
        key={`${runKey}:${state.startedAt ?? 0}`}
        runKey={runKey}
        state={state}
      />
      {state.status === "starting" && !state.hasOutput && (
        <div className="pointer-events-none absolute top-3 left-4 font-mono text-xs text-muted-foreground">
          Starting…
        </div>
      )}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear log"
          title="Clear log"
          // Above the terminal, whose hover-revealed scrollbar shares
          // this corner once the output overflows (the terminal wrapper
          // isolates xterm's own z-indexes, so any positive value wins).
          className="absolute top-2 right-3 z-10 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// One xterm instance per run (keyed on the run key and start time by
// the parent, so a rerun or another script mounts a fresh one -- xterm
// applies writes asynchronously, so reusing a terminal across runs
// would let the old run's queued tail paint over the new one). It is
// a real terminal, not a log view: the run's output is replayed into
// it byte for byte (so cursor movement, progress bars and full-screen
// programs render as they would in Terminal.app), keystrokes go back
// to the PTY while the run is live, and the PTY is told the viewport
// size so programs lay out for the space they have.
function ConsoleTerminal({ runKey, state }: Omit<ConsoleBodyProps, "onClear">) {
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
    const dataSub = term.onData((data) => scriptRuns.write(runKey, data));
    const resizeSub = term.onResize(({ cols, rows }) =>
      scriptRuns.resize(runKey, cols, rows),
    );
    // Catch up on the run so far in one write, then follow the log. The
    // two happen in the same tick, so nothing is missed or doubled.
    term.write(scriptRuns.readOutput(runKey).join(""));
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

    // Theme classes live on <html> and flip after this component's
    // own effects run, so watch the DOM rather than the theme hooks.
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
      attributeFilter: ["class"],
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
  }, [runKey]);

  // Typing only makes sense into a live PTY. Off the run, xterm stops
  // emitting onData (so no stray keystrokes hit the next run) and the
  // cursor is hidden, since there is nothing to type into. On it, take
  // focus so the user can type straight away, and tell the PTY the
  // viewport size once the grid is fitted -- xterm's onResize only
  // fires when the grid changes, which it doesn't for a run started
  // into an already-open console. The cursor writes queue behind the
  // replay above, so they land after it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const live = state.status === "running" && state.interactive;
    term.options.disableStdin = !live;
    term.write(live ? SHOW_CURSOR : HIDE_CURSOR);
    if (live) {
      term.focus();
      if (fittedRef.current) scriptRuns.resize(runKey, term.cols, term.rows);
    }
  }, [runKey, state.status, state.interactive]);

  // Padding lives on the wrapper: the fit addon sizes the grid from the
  // host's box width, so padding on the host itself would be counted as
  // usable columns. `isolate` keeps xterm's internal z-indexes from
  // competing with the console's own controls. xterm's stylesheet paints
  // its viewport black and the theme background only reaches the scroll
  // element inside it, so the strip below the last full row would show
  // black. Letting the console's background through fixes that.
  return (
    <div
      data-slot="script-console"
      data-keyboard-surface="raw"
      className="isolate h-full w-full px-4 py-3 font-mono text-xs"
    >
      <div
        ref={hostRef}
        className="h-full w-full [&_.xterm]:h-full [&_.xterm-viewport]:bg-transparent"
      />
    </div>
  );
}
