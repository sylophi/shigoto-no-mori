// A loopback listener that plays the running app on the control wire,
// as cli/control_test.go's scripted server does: it reads the hello and
// the request, then writes the frames `reply` answers with (one line
// each) and hangs up. Both the Go sm and the engine dial it.
import { createServer, type Socket } from "node:net";

export type Frame = Readonly<Record<string, unknown>>;

// What one connection sent: its hello, and its request once welcomed.
type Received = {
  readonly hello: unknown;
  readonly request?: unknown;
};

export const TOKEN = "good-token";

export type FakeApp = {
  readonly port: number;
  // control.json naming this listener, as the app publishes it.
  readonly file: (token?: string) => Frame;
  // What the connections sent since the last look, in order.
  readonly received: () => ReadonlyArray<Received>;
  readonly close: () => Promise<void>;
};

const lines = (socket: Socket, onLine: (line: string) => void) => {
  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const parts = `${partial}${chunk}`.split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  });
};

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

const write = (socket: Socket, frame: Frame) =>
  socket.write(`${JSON.stringify(frame)}\n`);

// `busy` turns every connection away as an app at its cap does.
export const fakeApp = async (
  reply: (request: Frame) => ReadonlyArray<Frame>,
  options: { readonly busy?: boolean } = {},
): Promise<FakeApp> => {
  let seen: Received[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (options.busy === true) {
      socket.end(
        `${JSON.stringify({ t: "refused", code: "busy", message: "too many control connections" })}\n`,
      );
      return;
    }
    let hello: unknown;
    lines(socket, (line) => {
      if (hello === undefined) {
        hello = parse(line);
        const token = (hello as { token?: unknown } | null)?.token;
        if (token !== TOKEN) {
          seen.push({ hello });
          socket.end(
            `${JSON.stringify({ t: "refused", code: "bad-token", message: "bad token" })}\n`,
          );
          return;
        }
        write(socket, { t: "welcome", appVersion: "1.2.3" });
        return;
      }
      const request = parse(line);
      seen.push({ hello, request });
      for (const frame of reply(request as Frame)) write(socket, frame);
      socket.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    file: (token = TOKEN) => ({
      pid: process.pid,
      port,
      token,
      appVersion: "1.2.3",
    }),
    received: () => {
      const taken = seen;
      seen = [];
      return taken;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

// The answer to a request, in the id it came with.
export const success = (request: Frame, result: unknown): Frame => ({
  t: "res",
  id: request["id"],
  ok: true,
  result,
});

// The app's refusal, with its code.
export const refusal = (
  request: Frame,
  message: string,
  code?: string,
): Frame => ({
  t: "res",
  id: request["id"],
  ok: false,
  message,
  ...(code === undefined ? {} : { code }),
});

export const progress = (payload: unknown): Frame => ({
  t: "push",
  channel: "sync:pullProgress",
  payload,
});
