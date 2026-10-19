// Durable proof for a drop of the window's link to its own app (the host
// restarting under it): reads cut by it ask again quietly until the host
// is back, an action it cut says once what happened, and neither says
// "device". A hub-bound read whose hub socket dropped stays quiet too.
// And main.log's lines for a restart: what the host had open at its
// last beat, and the spans it last finished (main/core/host/restartLog.ts).
//
// Run: pnpm test own-app-drop.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, it, vi } from "vitest";
import { NoDirectConnectionError } from "@shigomori/contracts/errors";
import { RemoteDisconnectedError } from "@shared/remote/rpcTransport";
import {
  createAppQueryClient,
  OWN_APP_DROP_WORDS,
} from "@/lib/queryClientOptions";
import { lastEndedSpans, restartDetail } from "../main/core/host/restartLog.ts";

const toasts: Array<{ title: string; error: unknown }> = [];
vi.mock("@/lib/toast", () => ({
  notifyError: (title: string, error: unknown) => toasts.push({ title, error }),
}));

it("a read the host's restart cut asks again quietly, and gets its answer", async () => {
  toasts.length = 0;
  const client = createAppQueryClient(() => undefined);
  let asks = 0;
  const value = await client.fetchQuery({
    queryKey: ["cut"],
    queryFn: async () => {
      asks += 1;
      // More cuts than the three retries a read otherwise gets.
      if (asks <= 5) throw new RemoteDisconnectedError(true);
      return "answer";
    },
    retryDelay: 0,
  });
  assert.equal(value, "answer");
  assert.equal(asks, 6);
  assert.deepEqual(toasts, []);
});

it("a read that failed on the drop toasts nothing", async () => {
  toasts.length = 0;
  const client = createAppQueryClient(() => undefined);
  for (const error of [
    new RemoteDisconnectedError(true),
    new NoDirectConnectionError({
      deviceId: "peer",
      reason: "the hub dropped",
    }),
  ]) {
    await client
      .fetchQuery({
        queryKey: ["failed", String(error)],
        queryFn: async () => {
          throw error;
        },
        retry: false,
      })
      .catch(() => {});
  }
  assert.deepEqual(toasts, []);
});

it("an action the drop cut says so once, in words that name the app's process", async () => {
  toasts.length = 0;
  const client = createAppQueryClient(() => undefined);
  const commit = () =>
    client
      .getMutationCache()
      .build(client, {
        mutationFn: async () => {
          throw new RemoteDisconnectedError(true);
        },
        meta: { errorTitle: "Couldn't commit" },
      })
      .execute(undefined)
      .catch(() => {});
  await commit();
  assert.deepEqual(toasts, [
    { title: "Couldn't commit", error: OWN_APP_DROP_WORDS },
  ]);
  assert.doesNotMatch(OWN_APP_DROP_WORDS, /device/);
  assert.doesNotMatch(new RemoteDisconnectedError(true).message, /device/);
});

const dirs: string[] = [];
const span = (name: string, outcome: string, error?: string) =>
  JSON.stringify({
    name,
    traceId: "t1",
    spanId: "s1",
    start: "2026-10-16T15:17:18.002Z",
    durationMs: 4.6,
    outcome,
    error,
  });
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("a restart's lines name what the host was in and what it last finished", async () => {
  const logs = mkdtempSync(join(tmpdir(), "sm-restart-log-"));
  dirs.push(logs);
  writeFileSync(
    join(logs, "host-trace.log"),
    // A tail can start mid-line, which is skipped.
    `ttributes":{}}\n${span("Views.view", "ok")}\n${span(
      "Worktrees.list",
      "failed",
      "git exited 128",
    )}\n${JSON.stringify({
      ...JSON.parse(span("Graph.cycle", "ok")),
      // The tracer's line for attributes it couldn't write.
      attributes: "unserializable",
    })}\n`,
  );
  const ended = await lastEndedSpans(logs);
  assert.equal(ended.length, 3);
  assert.match(ended[0] ?? "", /Views\.view 5 ms ok$/);
  assert.match(ended[1] ?? "", /Worktrees\.list 5 ms failed: git exited 128$/);
  assert.match(ended[2] ?? "", /Graph\.cycle 5 ms ok$/);
  const lines = restartDetail({
    beat: {
      at: 1_000,
      beat: { open: [{ name: "GitWatcher.start", ms: 2_500 }] },
    },
    now: 5_000,
    ended,
  });
  assert.equal(
    lines[0],
    "[host]   at its last beat, 4.0 s before: in GitWatcher.start (2.5 s)",
  );
  assert.equal(lines[1], "[host]   the last spans it finished:");
  assert.equal(lines.length, 5);
  assert.deepEqual(await lastEndedSpans(join(logs, "missing")), []);
});
