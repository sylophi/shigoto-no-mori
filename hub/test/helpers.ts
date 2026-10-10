// Shared plumbing for the suite: a worker instance with a stub Clerk
// verifier (tokens look like `test-token:<accountId>`), HTTP helpers,
// and a TestSocket wrapper that turns websocket events into awaitable
// queues so tests read as straight-line scripts.
import * as Schema from "effect/Schema";
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect } from "vitest";
import {
  type DeviceEnvelope,
  type EnrollResponse,
  EnrollResponseSchema,
  type OnlineDevice,
  type ServerEnvelope,
  ServerEnvelopeSchema,
  type TicketResponse,
  TicketResponseSchema,
  decodeEnvelope,
  encodeEnvelope,
} from "@shigomori/contracts/hubProtocol";
import { PROTOCOL_HEADER } from "@shigomori/contracts/hubApi";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import type { Env } from "../src/env.ts";
import { createWorker, type HubDeps } from "../src/worker.ts";

export const TEST_TOKEN_PREFIX = "test-token:";

// A worker with the stub Clerk verifier, plus whatever extra deps a
// spec injects (tunnel.spec.ts passes its Cloudflare API stub as
// cfFetch), so every spec composes the worker the same way.
export function makeTestWorker(
  extraDeps: Omit<HubDeps, "verifyLogin"> = {},
): ReturnType<typeof createWorker> {
  return createWorker({
    verifyLogin: async (token) =>
      token.startsWith(TEST_TOKEN_PREFIX)
        ? { accountId: token.slice(TEST_TOKEN_PREFIX.length) }
        : null,
    ...extraDeps,
  });
}

const worker = makeTestWorker();

export const BASE = "https://hub.test";

// Drives a worker exactly like production would, against the real
// bindings. A request names this build's protocol unless it names one
// itself, as every app request does. Upgrade responses skip waitOnExecutionContext because the
// socket outlives the request. Defaults to the shared stub worker, and
// specs with their own deps pass a makeTestWorker instance.
export async function call(
  request: Request,
  testEnv: Env = env,
  testWorker: ReturnType<typeof createWorker> = worker,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(request.headers);
  if (!headers.has(PROTOCOL_HEADER)) {
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
  }
  const response = await testWorker.fetch(
    new Request(request, { headers }),
    testEnv,
    ctx,
  );
  if (response.status !== 101) await waitOnExecutionContext(ctx);
  return response;
}

// Request builders for the endpoints the specs hit repeatedly, built
// from the shared route table. They make no status assertion, the
// callers do.
// The public key a test device enrolls with, distinct per device id.
// The hub stores and hands it on without using it, so any string of the
// key's shape serves.
export function testPublicKey(deviceId: string): string {
  return `${deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}${"k".repeat(43)}`.slice(
    0,
    43,
  );
}

// The body gets a key unless it names its own (an explicit undefined
// leaves it out).
export function enrollRequest(
  token: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`${BASE}/devices/enroll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      publicKey: testPublicKey(String(body.deviceId)),
      ...body,
    }),
  });
}

// A connection id as a dialer mints one: 16 random bytes as hex.
export function newConnectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function ticketRequest(
  credential: string,
  connectionId = newConnectionId(),
): Request {
  return new Request(`${BASE}/tickets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connectionId }),
  });
}

export function revokeRequest(credential: string, deviceId: string): Request {
  return new Request(`${BASE}/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${credential}` },
  });
}

export function updateRequest(
  credential: string,
  deviceId: string,
  body: unknown,
): Request {
  return new Request(`${BASE}/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function provisionRequest(credential: string, port: number): Request {
  return new Request(`${BASE}/tunnel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ port }),
  });
}

export async function revoke(
  credential: string,
  deviceId: string,
): Promise<Response> {
  return await call(revokeRequest(credential, deviceId));
}

export async function enroll(
  accountId: string,
  deviceId: string,
  name = "Test Device",
  platform = "darwin",
  icon = "laptop",
): Promise<EnrollResponse> {
  const response = await call(
    enrollRequest(`${TEST_TOKEN_PREFIX}${accountId}`, {
      deviceId,
      name,
      platform,
      icon,
    }),
  );
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(EnrollResponseSchema)(await response.json());
}

export async function mintTicket(
  credential: string,
  testEnv: Env = env,
  connectionId?: string,
): Promise<TicketResponse> {
  const response = await call(ticketRequest(credential, connectionId), testEnv);
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(TicketResponseSchema)(await response.json());
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

  // Consumes envelopes until a presence message names exactly the
  // `expected` device ids, under one overall deadline, and answers its
  // roster. Presence is a full list, so skipping intermediate
  // broadcasts (for example the double broadcast around a supersede)
  // is safe.
  async untilPresence(
    expected: string[],
    timeoutMs = 2000,
  ): Promise<ReadonlyArray<OnlineDevice>> {
    const want = JSON.stringify(expected.toSorted());
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- envelopes arrive one at a time, waiting is the point
      const envelope = await this.next(Math.max(1, deadline - Date.now()));
      if (
        envelope.t === "presence" &&
        JSON.stringify(envelope.online.map((device) => device.deviceId)) ===
          want
      ) {
        return envelope.online;
      }
    }
  }

  // Consumes envelopes until a relayed frame equals `frame`, under one
  // overall deadline.
  async untilRelay(frame: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- envelopes arrive one at a time, waiting is the point
      const envelope = await this.next(Math.max(1, deadline - Date.now()));
      if (envelope.t === "relay" && envelope.frame === frame) return;
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

// Opens the hub socket for a ticket. The upgrade itself succeeds for
// every parseable ticket, rejection arrives as a close code.
export async function openSocket(
  ticket: string,
  testEnv: Env = env,
): Promise<TestSocket> {
  const params = new URLSearchParams({ ticket: ticket });
  const response = await call(
    new Request(`${BASE}/connect?${params}`, {
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
// hub tests.
export async function enrollAndConnect(
  accountId: string,
  deviceId: string,
): Promise<{ credential: string; socket: TestSocket }> {
  const { credential } = await enroll(accountId, deviceId);
  const { ticket } = await mintTicket(credential);
  const socket = await openSocket(ticket);
  return { credential, socket };
}
