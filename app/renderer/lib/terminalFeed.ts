// A terminal's feed (TerminalView): terminals.attach on its device,
// written into the screen. A link that drops is attached again with the
// mark of the last chunk the screen has, so it picks up after it with
// nothing repeated or missed, or, once the host's history no longer
// reaches back that far, starts over from all of it. A host that
// restarted runs another incarnation of the shell, so the screen starts
// over then too.
import { isUnknownTerminalError } from "@shigomori/contracts/errors";
import { backoffDelayMs } from "@shared/remote/supervisor";
import type { TerminalScreen } from "@shigomori/ui/views/terminal/TerminalView.tsx";
import { terminalsContract } from "@shigomori/contracts/modules/terminals";
import type { HostApi } from "@/hooks/remote/useHostScope";

// A view not started yet stops nothing.
const noop = (): void => {};

// The waits between attaches that ended with the link.
const RETRY_DELAYS_MS: readonly [number, ...number[]] = [
  250, 500, 1_000, 2_000, 5_000,
];

export function attachTerminal(
  api: Pick<HostApi, "view" | "listen">,
  terminalId: string,
  screen: TerminalScreen,
  // The shell exited (its code, null for a signal or a close), or the
  // terminal is gone from the host.
  onEnd: (code: number | null) => void,
): () => void {
  let after: { incarnation: string; seq: number } | undefined;
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
    stop = api.listen(
      api.view(
        terminalsContract,
        "attach",
        after === undefined ? { terminalId } : { terminalId, after },
      ),
      (event) => {
        if (mine !== current || stopped) return;
        attempt = 0;
        switch (event.kind) {
          case "history":
            screen.replay(event.data, event.reset);
            after = { incarnation: event.incarnation, seq: event.seq };
            return;
          case "output":
            if (after === undefined || event.seq <= after.seq) return;
            screen.write(event.data);
            after = { ...after, seq: event.seq };
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
      (failure) => {
        if (mine !== current || stopped) return;
        if (failure === undefined || isUnknownTerminalError(failure)) {
          stopped = true;
          onEnd(null);
          return;
        }
        const wait = backoffDelayMs(RETRY_DELAYS_MS, attempt);
        attempt += 1;
        timer = setTimeout(watch, wait);
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
