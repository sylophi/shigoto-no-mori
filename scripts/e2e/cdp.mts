// A Chrome DevTools Protocol client just big enough to drive a dev
// app window (main/electron/devCdp.ts opens the port under
// SHIGOMORI_DEBUG_PORT): evaluate in the renderer, wait for a
// condition, screenshot. The preload puts window.api in the main
// world, so a driven window is asked things through the real bridge
// (`window.api.hub.status()`) and the DOM is touched only where a
// human would have to (the Clerk modal).
//
// Rides the `ws` package the app already depends on, no new
// dependency. One connection per window. Requests are id-correlated,
// so callers may overlap them.
import { createRequire } from "node:module";
import { errorMessageOf } from "../../shared/errors.ts";
import { rendererSchemeName } from "../../shared/rendererScheme.mts";
import { delay } from "../lib/checkKit.mjs";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws") as typeof import("ws");

const DEV_PAGE_PREFIX = `${rendererSchemeName("dev")}://`;

type Target = { type: string; url: string; webSocketDebuggerUrl: string };

export type AppWindow = {
  port: number;
  // Runs `expression` in the renderer, awaiting a promise result, and
  // returns its JSON value. A thrown exception rejects with its text.
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  // Polls `expression` (which must evaluate to something truthy when
  // satisfied) until it is, returning the value, or rejects after
  // `timeoutMs` naming `what`.
  waitFor: <T = unknown>(
    what: string,
    expression: string,
    timeoutMs?: number,
  ) => Promise<T>;
  screenshot: () => Promise<Buffer>;
  close: () => void;
};

// Polls the CDP port until the app's page target exists and its
// bridge is installed, so a driver can attach right after launching
// the process. The whole wait shares one `timeoutMs` budget.
export async function attachWindow(
  port: number,
  timeoutMs = 60_000,
): Promise<AppWindow> {
  const deadline = Date.now() + timeoutMs;
  let page: Target | undefined;
  // oxlint-disable no-await-in-loop -- a poll is sequential by nature
  while (page === undefined) {
    try {
      const targets = (await (
        await fetch(`http://localhost:${port}/json`, {
          signal: AbortSignal.timeout(2000),
        })
      ).json()) as Target[];
      page = targets.find(
        (t) => t.type === "page" && t.url.startsWith(DEV_PAGE_PREFIX),
      );
    } catch {
      // Port not open yet.
    }
    if (page === undefined) {
      if (Date.now() > deadline) {
        throw new Error(
          `no app window on CDP port ${port} after ${timeoutMs}ms`,
        );
      }
      await delay(500);
    }
  }
  // oxlint-enable no-await-in-loop

  // The handshake shares the budget too, and its error listener goes
  // once open so a later socket error is not swallowed by it.
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => {
        socket.off("error", onError);
        socket.terminate();
        reject(new Error(`CDP handshake to port ${port} timed out`));
      },
      Math.max(1_000, deadline - Date.now()),
    );
    socket.once("error", onError);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve();
    });
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`CDP socket to port ${port} closed`));
    }
    pending.clear();
  });

  const send = (method: string, params: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const result = (await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value as T;
  };

  // A condition that throws is one that is not met yet (the bridge
  // not installed, a query not answerable), so the poll keeps going
  // and the timeout names the last reason.
  const waitFor = async <T,>(
    what: string,
    expression: string,
    waitMs = 30_000,
  ): Promise<T> => {
    const until = Date.now() + waitMs;
    let lastError = "";
    for (;;) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
        const value = await evaluate<T>(expression);
        if (value) return value;
        lastError = "";
      } catch (error) {
        lastError = errorMessageOf(error);
      }
      if (Date.now() > until) {
        throw new Error(
          `timed out after ${waitMs}ms waiting for ${what}` +
            (lastError === "" ? "" : ` (last error: ${lastError})`),
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await delay(500);
    }
  };

  // The page target exists before the preload has run, so a caller
  // attached this early would find no bridge yet. The bridge gets what
  // is left of the budget, and a floor: a window found late is not a
  // broken one.
  try {
    await waitFor(
      "the renderer bridge",
      'typeof window.api === "object"',
      Math.max(10_000, deadline - Date.now()),
    );
  } catch (error) {
    socket.close();
    throw error;
  }

  return {
    port,
    evaluate,
    waitFor,
    screenshot: async () => {
      const result = (await send("Page.captureScreenshot", {
        format: "png",
      })) as { data: string };
      return Buffer.from(result.data, "base64");
    },
    close: () => socket.close(),
  };
}
