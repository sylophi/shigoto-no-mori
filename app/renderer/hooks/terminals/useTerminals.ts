import { useEffect, useState } from "react";
import type { Terminal } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The waits between watches that ended with the link.
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

// The scoped device's open terminals, as terminals.list streams them.
// Null until the first answer, and while the device gives none (a peer
// that runs no commands from here).
export function useTerminals(): readonly Terminal[] | null {
  const { api, hasHost } = useHostScope();
  const [terminals, setTerminals] = useState<readonly Terminal[] | null>(null);
  useEffect(() => {
    if (!hasHost) return;
    let attempt = 0;
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      stop = api.terminals.list(undefined, {
        value: (value) => {
          attempt = 0;
          setTerminals(value.terminals);
        },
        end: () => {
          const wait =
            RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
          attempt += 1;
          timer = setTimeout(watch, wait);
        },
      });
    };
    watch();
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [api, hasHost]);
  return terminals;
}
