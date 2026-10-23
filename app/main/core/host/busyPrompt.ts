// A busy prompt (electron/busyPrompt.ts) that follows the work it names
// while it is up: the host is asked again every `every` ms, and when the
// words change the prompt is taken down and asked again in the new ones.
// With nothing left to interrupt, read twice in a row (a loop typed at a
// shell hands the terminal back between its commands), it goes ahead,
// since the person already asked to quit or restart.
import * as Option from "effect/Option";

type Following = {
  // The prompt's words for what is under way now, null for nothing.
  readonly detail: () => Promise<string | null>;
  // The same, asked again while the prompt is up: none when the host
  // didn't answer in time, which leaves the prompt as it is.
  readonly again: () => Promise<Option.Option<string | null>>;
  // The prompt, true to go ahead. The signal takes it down.
  readonly show: (detail: string, signal: AbortSignal) => Promise<boolean>;
  readonly every: number;
};

export async function followBusy(options: Following): Promise<boolean> {
  const detail = await options.detail();
  return detail === null ? true : ask(options, detail);
}

// One showing of the prompt, and the next when its words change.
async function ask(options: Following, shown: string): Promise<boolean> {
  const changed = new AbortController();
  let next: string | null = shown;
  let answered = false;
  let idleOnce = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    timer = setTimeout(() => {
      // A read that fails leaves the prompt as it is too.
      void options
        .again()
        .catch(() => Option.none<string | null>())
        .then((now) => {
          if (answered) return;
          if (Option.isNone(now)) return poll();
          if (now.value === null && !idleOnce) {
            idleOnce = true;
            return poll();
          }
          idleOnce = false;
          if (now.value === shown) return poll();
          next = now.value;
          changed.abort();
        });
    }, options.every);
  };
  poll();
  let proceed: boolean;
  try {
    proceed = await options.show(shown, changed.signal);
  } finally {
    answered = true;
    clearTimeout(timer);
  }
  if (!changed.signal.aborted) return proceed;
  return next === null ? true : ask(options, next);
}
