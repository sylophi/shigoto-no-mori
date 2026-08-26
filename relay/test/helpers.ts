// Shared plumbing for the suite: a worker instance with a stub Clerk
// verifier (tokens look like `test-token:<accountId>`), HTTP helpers,
// and a TestSocket wrapper that turns websocket events into awaitable
// queues so tests read as straight-line scripts.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect } from "vitest";
import {
  CONNECT_TICKET_PARAM,
  type DeviceEnvelope,
  type EnrollResponse,
  EnrollResponseSchema,
  RELAY_ROUTES,
  type ServerEnvelope,
  ServerEnvelopeSchema,
  type TicketResponse,
  TicketResponseSchema,
  decodeEnvelope,
  encodeEnvelope,
} from "../../shared/relay/protocol.ts";
import type { Env } from "../src/env.ts";
import { createWorker } from "../src/worker.ts";

export const TEST_TOKEN_PREFIX = "test-token:";

const worker = createWorker({
  verifyLogin: async (token) =>
    token.startsWith(TEST_TOKEN_PREFIX)
      ? { accountId: token.slice(TEST_TOKEN_PREFIX.length) }
      : null,
});

export const BASE = "https://relay.test";

// Drives the worker exactly like production would, against the real
// bindings. Upgrade responses skip waitOnExecutionContext because the
// socket outlives the request.
export async function call(
  request: Request,
  testEnv: Env = env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  if (response.status !== 101) await waitOnExecutionContext(ctx);
  return response;
}

// Request builders for the endpoints the specs hit repeatedly, built
// from the shared route table. They make no status assertion, the
// callers do.
export function enrollRequest(token: string, body: unknown): Request {
  return new Request(`${BASE}${RELAY_ROUTES.enroll.path}`, {
    method: RELAY_ROUTES.enroll.method,
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export function ticketRequest(credential: string): Request {
  return new Request(`${BASE}${RELAY_ROUTES.mintTicket.path}`, {
    method: RELAY_ROUTES.mintTicket.method,
    headers: { Authorization: `Bearer ${credential}` },
  });
}

export async function revoke(
  credential: string,
  deviceId: string,
): Promise<Response> {
  return await call(
    new Request(`${BASE}${RELAY_ROUTES.revokeDevice.path(deviceId)}`, {
      method: RELAY_ROUTES.revokeDevice.method,
      headers: { Authorization: `Bearer ${credential}` },
    }),
  );
}

export async function enroll(
  accountId: string,
  deviceId: string,
  name = "Test Device",
  platform = "darwin",
): Promise<EnrollResponse> {
  const response = await call(
    enrollRequest(`${TEST_TOKEN_PREFIX}${accountId}`, {
      deviceId,
      name,
      platform,
    }),
  );
  expect(response.status).toBe(200);
  return EnrollResponseSchema.parse(await response.json());
}

export async function mintTicket(
  credential: string,
  testEnv: Env = env,
): Promise<TicketResponse> {
  const response = await call(ticketRequest(credential), testEnv);
  expect(response.status).toBe(200);
  return TicketResponseSchema.parse(await response.json());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every socket a test opens is registered here and force-closed by
// closeAllSockets (called from afterEach in the specs), so a failing
// test never leaks a live socket into the next one.
const openSockets = new Set<TestSocket>();

export async function closeAllSockets(): Promise<void> {
  for (const socket of openSockets) socket.close("test cleanup");
  openSockets.clear();
  // Give the DO a beat to run its close handlers before the next test
  // starts, so late presence broadcasts land nowhere surprising.
  await sleep(20);
}

export class TestSocket {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly queue: ServerEnvelope[] = [];
  private readonly waiters: Array<(envelope: ServerEnvelope) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const envelope = decodeEnvelope(event.data, ServerEnvelopeSchema);
      if (envelope === null) return;
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(envelope);
      else this.queue.push(envelope);
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });
    openSockets.add(this);
  }

  send(envelope: DeviceEnvelope): void {
    this.ws.send(encodeEnvelope(envelope));
  }

  next(timeoutMs = 2000): Promise<ServerEnvelope> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(settle);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for a server envelope"));
      }, timeoutMs);
      const settle = (envelope: ServerEnvelope) => {
        clearTimeout(timer);
        resolve(envelope);
      };
      this.waiters.push(settle);
    });
  }

  // Consumes envelopes until a presence message matches `expected`,
  // under one overall deadline. Presence is a full list, so skipping
  // intermediate broadcasts (for example the double broadcast around
  // a supersede) is safe.
  async untilPresence(expected: string[], timeoutMs = 2000): Promise<void> {
    const want = JSON.stringify(expected.toSorted());
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- envelopes arrive one at a time, waiting is the point
      const envelope = await this.next(Math.max(1, deadline - Date.now()));
      if (
        envelope.t === "presence" &&
        JSON.stringify(envelope.online) === want
      ) {
        return;
      }
    }
  }

  // Asserts nothing arrives for a while, for "the other account saw
  // none of this" style checks.
  async expectSilence(ms = 100): Promise<void> {
    await sleep(ms);
    expect(this.queue).toEqual([]);
  }

  close(reason = "test done"): void {
    try {
      this.ws.close(1000, reason);
    } catch {
      // Already closed, nothing to clean.
    }
  }
}

// Opens the relay socket for a ticket. The upgrade itself succeeds for
// every parseable ticket, rejection arrives as a close code.
export async function openSocket(
  ticket: string,
  testEnv: Env = env,
): Promise<TestSocket> {
  const params = new URLSearchParams({ [CONNECT_TICKET_PARAM]: ticket });
  const response = await call(
    new Request(`${BASE}${RELAY_ROUTES.connect.path}?${params}`, {
      headers: { Upgrade: "websocket" },
    }),
    testEnv,
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("expected a websocket on the 101 response");
  return new TestSocket(ws);
}

// Enroll, mint and connect in one go, the common preamble of the
// relay tests.
export async function enrollAndConnect(
  accountId: string,
  deviceId: string,
): Promise<{ credential: string; socket: TestSocket }> {
  const { credential } = await enroll(accountId, deviceId);
  const { ticket } = await mintTicket(credential);
  const socket = await openSocket(ticket);
  return { credential, socket };
}
