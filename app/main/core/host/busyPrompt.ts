// A busy prompt (electron/busyPrompt.ts) that follows the work it names
// while it is up: the host is asked again every `every` ms, and when the
// words change the prompt is taken down and asked again in the new ones.
// With nothing left to interrupt it goes ahead, since the person already
// asked to quit or restart.
type Following = {
  // The prompt's words for what is under way now, null for nothing.
  readonly detail: () => Promise<string | null>;
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    timer = setTimeout(() => {
      // A read that fails leaves the prompt as it is.
      void options
        .detail()
        .catch(() => shown)
        .then((now) => {
          if (answered) return;
          if (now === shown) return poll();
          next = now;
          changed.abort();
        });
    }, options.every);
  };
  poll();
  const proceed = await options.show(shown, changed.signal);
  answered = true;
  clearTimeout(timer);
  if (!changed.signal.aborted) return proceed;
  return next === null ? true : ask(options, next);
}
