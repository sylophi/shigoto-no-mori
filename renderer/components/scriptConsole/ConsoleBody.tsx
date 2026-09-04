import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Trash2 } from "lucide-react";
import { notifyError } from "@/lib/toast";
import { type ScriptRunState } from "@/store/scriptRuns";
import { readTerminalTheme } from "./terminalTheme";

// DECTCEM: terminal cursor visibility.
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

interface ConsoleBodyProps {
  state: ScriptRunState;
  onClear: (() => void) | null;
  // Keystrokes and viewport size for the run's PTY; the store ignores
  // both unless the run is live and interactive.
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export function ConsoleBody({
  state,
  onClear,
  onInput,
  onResize,
}: ConsoleBodyProps) {
  if (state.status === "idle" && state.chunkTotal === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No runs yet. Press Run to start.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <ConsoleTerminal state={state} onInput={onInput} onResize={onResize} />
      {state.status === "starting" && state.chunkTotal === 0 && (
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
          className="absolute top-2 right-3 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// One xterm instance for the life of the console. It is a real
// terminal, not a log view: output is replayed into it byte for byte
// (so cursor movement, progress bars and full-screen programs render
// as they would in Terminal.app), keystrokes go back to the PTY while
// the run is live, and the PTY is told the viewport size so programs
// lay out for the space they have.
function ConsoleTerminal({
  state,
  onInput,
  onResize,
}: Omit<ConsoleBodyProps, "onClear">) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // How many of the run's chunks (state.chunkTotal) are in the terminal.
  const writtenRef = useRef(0);
  // The xterm listeners are registered once; route them through refs
  // so a parent re-render with fresh closures needs no re-subscription.
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onInputRef.current = onInput;
    onResizeRef.current = onResize;
  }, [onInput, onResize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      // Matches the host's `font-mono text-xs`; xterm sizes its cell
      // grid from these, so they can't come from CSS.
      fontFamily: getComputedStyle(host).fontFamily,
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5_000,
      theme: readTerminalTheme(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.api.shell
          .openExternal(uri)
          .catch((err) => notifyError("Couldn't open link", err));
      }),
    );
    term.open(host);
    const dataSub = term.onData((data) => onInputRef.current(data));
    const resizeSub = term.onResize(({ cols, rows }) =>
      onResizeRef.current(cols, rows),
    );
    termRef.current = term;
    writtenRef.current = 0;

    const refit = () => {
      // Throws while the host has no layout yet (route transition);
      // the observer fires again once it does.
      try {
        fit.fit();
      } catch {
        // See above.
      }
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    refit();
    // A fit measured before the monospace face has loaded gets the cell
    // width wrong; measure again once fonts settle.
    void document.fonts.ready.then(refit);

    // Theme classes live on <html> and flip after this component's
    // own effects run, so watch the DOM rather than the theme hooks.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme(host);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      themeObserver.disconnect();
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Write whatever the store holds that the terminal hasn't seen. A
  // total below what was written means the run was cleared or
  // restarted: start the terminal over rather than append.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (state.chunkTotal < writtenRef.current) {
      term.reset();
      writtenRef.current = 0;
    }
    const fresh = state.chunkTotal - writtenRef.current;
    if (fresh <= 0) return;
    const from = Math.max(0, state.output.length - fresh);
    for (const chunk of state.output.slice(from)) term.write(chunk);
    writtenRef.current = state.chunkTotal;
  }, [state.output, state.chunkTotal]);

  // Typing only makes sense into a live PTY. Off the run, xterm stops
  // emitting onData (so no stray keystrokes hit the next run) and the
  // cursor is hidden, since there is nothing to type into; on it, take
  // focus so the user can type straight away, and tell the new PTY the
  // viewport size -- xterm's onResize only fires when the grid
  // changes, which it doesn't for a run started into an already-open
  // console. The cursor writes queue behind the output writes above,
  // so they land after the replay (and after the reset a new run
  // starts with, which makes the cursor visible again).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const live = state.status === "running" && state.interactive;
    term.options.disableStdin = !live;
    term.write(live ? SHOW_CURSOR : HIDE_CURSOR);
    if (live) {
      term.focus();
      onResizeRef.current(term.cols, term.rows);
    }
  }, [state.status, state.interactive]);

  // Padding lives on the wrapper: the fit addon sizes the grid from the
  // host's box width, so padding on the host itself would be counted as
  // usable columns.
  return (
    <div className="h-full w-full px-4 py-3 font-mono text-xs">
      <div ref={hostRef} className="h-full w-full [&_.xterm]:h-full" />
    </div>
  );
}
