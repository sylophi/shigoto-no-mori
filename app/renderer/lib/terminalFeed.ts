// A terminal's feed (TerminalView): terminals.attach on its device,
// written into the screen. A link that drops, or a host that restarts,
// is attached again with the seq of the last chunk the screen has, so
// it picks up after it with nothing repeated or missed, or, once the
// host's history no longer reaches back that far, starts over from all
// of it.
import { isUnknownTerminalError } from "@shigomori/contracts/errors";
import type { TerminalScreen } from "@/components/terminal/TerminalView";
import type { HostApi } from "@/hooks/remote/useHostScope";

// A view not started yet stops nothing.
const noop = (): void => {};

// The waits between attaches that ended with the link.
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export function attachTerminal(
  api: { readonly terminals: Pick<HostApi["terminals"], "attach"> },
  terminalId: string,
  screen: TerminalScreen,
  // The shell exited (its code, null for a signal or a close), or the
  // terminal is gone from the host.
  onEnd: (code: number | null) => void,
): () => void {
  let after: number | undefined;
  let stopped = false;
  let attempt = 0;
  let stop = noop;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Each attach's own, so one that a later attach replaced writes
  // nothing more.
  let current = 0;
  const watch = () => {
    current += 1;
    const mine = current;
    stop = api.terminals.attach(
      after === undefined ? { terminalId } : { terminalId, after },
      {
        value: (event) => {
          if (mine !== current || stopped) return;
          attempt = 0;
          switch (event.kind) {
            case "history":
              screen.replay(event.data, event.reset);
              after = event.seq;
              return;
            case "output":
              if (after !== undefined && event.seq <= after) return;
              screen.write(event.data);
              after = event.seq;
              return;
            case "size":
              screen.resize(event.cols, event.rows);
              return;
            case "exit":
              stopped = true;
              onEnd(event.code);
              return;
          }
        },
        end: (failure) => {
          if (mine !== current || stopped) return;
          if (failure === undefined || isUnknownTerminalError(failure)) {
            stopped = true;
            onEnd(null);
            return;
          }
          const wait =
            RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
          attempt += 1;
          timer = setTimeout(watch, wait);
        },
      },
    );
  };
  watch();
  return () => {
    stopped = true;
    clearTimeout(timer);
    stop();
  };
}
