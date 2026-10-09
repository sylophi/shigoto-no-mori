// The desktop window's link to this machine's host: the device link's
// dialer (shared/remote/deviceLink.ts) on the loopback, with the token
// the shell hands over (window:hostAddress) in place of a ticket. A link
// that drops is dialed again, at the address the shell answers then, so
// a host that went away (and came back on another port) is a reconnect:
// calls made meanwhile wait for it, and subscriptions carry over.
import { LoopbackGroup } from "@shigomori/contracts/link";
import type { ClientTransport } from "@shared/ipc/transport";
import { log } from "@shared/log";
import { type DeviceConnection, openDevice } from "@shared/remote/deviceLink";
import { errorMessageOf } from "@shigomori/contracts/errors";

// How long one dial may take, and the waits between failed ones.
const DIAL_DEADLINE_MS = 10_000;
const REDIAL_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const;

export function connectHost(options: {
  readonly shell: ClientTransport;
  readonly deviceId: string;
  readonly appVersion: string;
}): ClientTransport {
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();

  const dialOnce = async (): Promise<DeviceConnection> => {
    const { port, token } = (await options.shell.invoke(
      "window:hostAddress",
      undefined,
    )) as { port: number; token: string };
    return openDevice({
      url: `ws://127.0.0.1:${port}`,
      ticket: token,
      group: LoopbackGroup,
      appVersion: options.appVersion,
      localDeviceId: options.deviceId,
      expectedDeviceId: options.deviceId,
      openSocket: (url) => new WebSocket(url),
      deadlineMs: DIAL_DEADLINE_MS,
      onClose: () => {
        current = dial();
      },
      onPush: (channel, payload) => {
        for (const handler of subscribers.get(channel) ?? []) handler(payload);
      },
    }).authenticate();
  };

  const dial = async (): Promise<DeviceConnection> => {
    for (let attempt = 0; ; attempt++) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one dial at a time
        return await dialOnce();
      } catch (error) {
        const wait =
          REDIAL_DELAYS_MS[Math.min(attempt, REDIAL_DELAYS_MS.length - 1)];
        log.warn(
          `[host] could not reach this machine's host, again in ${wait} ms: ${errorMessageOf(error)}`,
        );
        // oxlint-disable-next-line no-await-in-loop -- the wait between dials
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  let current = dial();

  return {
    // The host is this machine's own build, which decodes what it sends.
    local: true,
    invoke: async (channel, input, invokeOptions) =>
      (await current).transport.invoke(channel, input, invokeOptions),
    subscribe(channel, handler) {
      let handlers = subscribers.get(channel);
      if (handlers === undefined) {
        handlers = new Set();
        subscribers.set(channel, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
