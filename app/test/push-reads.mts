// Durable proof that a burst of pushes is a bounded number of reads and
// cancels none: each read a page shows goes one at a time, joined by
// whatever asks while it is out and followed by one more read
// (lib/askAgain.ts), as the device list's re-reads do. And
// that a read outside React joins a cancelled fetch a bounded number of
// times. And that a device's externalChange reads that device's own
// requests again, never this window's own (the releases, the account)
// nor another device's.
//
// Run: pnpm test push-reads.
import assert from "node:assert/strict";
import {
  CancelledError,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { it } from "vitest";
import { watchHost, type WatchedHostApi } from "@/lib/hostWatch";
import { queryKeys, queryKeysFor } from "@/lib/queryKeys";
import { throughCancel } from "@/lib/queryClientOptions";
import { fetchAgain, refreshQueries } from "@/lib/askAgain";

const DEVICE = "device-1";
const keys = queryKeysFor(DEVICE);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A host's pushes, delivered by hand: the handlers watchHost listens
// with, by the push's channel name.
function fakeHost() {
  const handlers = new Map<string, (value: unknown) => void>();
  // oxlint-disable-next-line shigomori/no-double-cast -- a stand-in whose pushes are their channel names, which is all watchHost hands back to listen
  const api = {
    pushes: (_module: unknown, key: string) => key,
    listen: (stream: unknown, onValue: (value: unknown) => void) => {
      handlers.set(stream as string, onValue);
      return () => handlers.delete(stream as string);
    },
  } as unknown as WatchedHostApi;
  const push = (key: string, value: unknown) => {
    const handler = handlers.get(key);
    assert.ok(handler, `nothing listens for ${key}`);
    handler(value);
  };
  return { api, push };
}

// A query a page shows, each read 100 ms, counting its reads and the
// reads cancelled under it.
function shownQuery(client: QueryClient, queryKey: readonly unknown[]) {
  const counts = { reads: 0, cancelled: 0 };
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: async ({ signal }) => {
      counts.reads += 1;
      signal.addEventListener("abort", () => {
        counts.cancelled += 1;
      });
      await sleep(100);
      return counts.reads;
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { counts, unsubscribe };
}

// 25 pushes about 5 ms apart, then time for the reads to settle. Answers
// the most reads it may cost, each read 100 ms: the first, and one after
// each read a push came during, however long the burst took here.
async function burst(send: () => void): Promise<number> {
  const started = performance.now();
  for (let push = 0; push < 25; push++) {
    send();
    await sleep(5);
  }
  const lasted = performance.now() - started;
  await sleep(400);
  return Math.ceil(lasted / 100) + 1;
}

it("a burst of refsRefreshed pushes reads an open page's pull request a bounded number of times and cancels none", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const page = shownQuery(client, keys.worktreePullRequest("p1", "feature"));
  await sleep(150);
  const before = page.counts.reads;
  const most = await burst(() =>
    host.push("refsRefreshed", { projectId: "p1" }),
  );
  assert.equal(page.counts.cancelled, 0, "a read cancelled by the next push");
  const reads = page.counts.reads - before;
  assert.ok(reads >= 2 && reads <= most, `read ${reads} times of ${most}`);
  page.unsubscribe();
  stop();
  client.clear();
});

it("a burst of projectChanged pushes reads that project's rows a bounded number of times, cancels none, and leaves another project's alone", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const rows = shownQuery(client, keys.branches("p1"));
  const other = shownQuery(client, keys.branches("p2"));
  await sleep(150);
  const before = { rows: rows.counts.reads, other: other.counts.reads };
  const most = await burst(() =>
    host.push("projectChanged", { projectId: "p1" }),
  );
  assert.equal(rows.counts.cancelled, 0, "a read cancelled by the next push");
  const reads = rows.counts.reads - before.rows;
  assert.ok(reads >= 2 && reads <= most, `read ${reads} times of ${most}`);
  assert.equal(other.counts.reads, before.other, "another project was read");
  rows.unsubscribe();
  other.unsubscribe();
  stop();
  client.clear();
});

it("a read a push asks for while one is out follows it, and a query no page shows goes stale without a read", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const page = shownQuery(client, keys.defaultBranch("p1"));
  // The page's own first read is out as the push comes: it may predate
  // what moved, so one more follows it.
  host.push("refsRefreshed", { projectId: "p1" });
  await sleep(400);
  assert.equal(page.counts.reads, 2, "the read out, then one after it");
  assert.equal(page.counts.cancelled, 0);
  page.unsubscribe();
  const hidden = client.getQueryCache().find({
    queryKey: keys.defaultBranch("p1"),
    exact: true,
  });
  host.push("refsRefreshed", { projectId: "p1" });
  await sleep(200);
  assert.equal(page.counts.reads, 2, "a query no page shows was read");
  assert.equal(
    hidden?.state.isInvalidated,
    true,
    "left fresh for the next page",
  );
  stop();
  client.clear();
});

it("a page that leaves during a joined read leaves its query stale, not read again and not fresh", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const page = shownQuery(client, keys.shigomoriConfig("p1"));
  host.push("projectChanged", { projectId: "p1" });
  await sleep(20);
  page.unsubscribe();
  await sleep(300);
  assert.equal(page.counts.reads, 1, "read again with no page");
  const query = client.getQueryCache().find({
    queryKey: keys.shigomoriConfig("p1"),
    exact: true,
  });
  assert.equal(
    query?.state.isInvalidated,
    true,
    "left fresh for the next page",
  );
  stop();
  client.clear();
});

it("a read a mutation cancels for its optimistic write is not followed by a read before the mutation lands", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const queryKey = keys.worktreePullRequest("p1", "feature");
  const page = shownQuery(client, queryKey);
  host.push("refsRefreshed", { projectId: "p1" });
  await sleep(20);
  await client.cancelQueries({ queryKey });
  await sleep(300);
  assert.equal(page.counts.reads, 1, "read again under the optimistic write");
  page.unsubscribe();
  stop();
  client.clear();
});

it("an optimistic write over a shown answer survives a refresh's read and the one owed after it", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const queryKey = keys.worktreePullRequest("p1", "feature");
  const page = shownQuery(client, queryKey);
  await sleep(150);
  // A refresh's read out over the shown answer, and another push owing
  // one more after it.
  host.push("refsRefreshed", { projectId: "p1" });
  await sleep(10);
  host.push("refsRefreshed", { projectId: "p1" });
  await sleep(10);
  // A mutation's optimistic write: it cancels what is out and writes.
  await client.cancelQueries({ queryKey });
  client.setQueryData(queryKey, "optimistic");
  await sleep(300);
  assert.equal(page.counts.reads, 2, "read again under the optimistic write");
  assert.equal(client.getQueryData(queryKey), "optimistic");
  page.unsubscribe();
  stop();
  client.clear();
});

it("an ask that must reach a query no page reads (the device list) is kept when a page's refresh started the read and the page leaves", async () => {
  const client = new QueryClient();
  const queryKey = ["account", "devices"];
  const page = shownQuery(client, queryKey);
  await sleep(150);
  refreshQueries(client, { queryKey });
  const query = client.getQueryCache().find({ queryKey, exact: true });
  assert.ok(query);
  fetchAgain(client, query, false);
  page.unsubscribe();
  await sleep(400);
  assert.equal(page.counts.reads, 3, "the store's ask was dropped");
  client.clear();
});

it("a read outside React joins a cancelled fetch at most three more times", async () => {
  let asked = 0;
  await assert.rejects(
    () =>
      throughCancel(async () => {
        asked += 1;
        throw new CancelledError();
      }),
    (error) => error instanceof CancelledError,
  );
  assert.equal(asked, 4);
});

it("a device's externalChange reads its own requests again, not this window's nor another device's", async () => {
  const client = new QueryClient();
  const host = fakeHost();
  const stop = watchHost(client, DEVICE, host.api);
  const own = shownQuery(client, keys.branches("p1"));
  const releases = shownQuery(client, queryKeys.releases());
  const peer = shownQuery(client, queryKeysFor("device-2").branches("p1"));
  await sleep(150);
  host.push("externalChange", undefined);
  // The sweep starts every read it asks for at once, so the device's own
  // read again is the fence for the two it must not have asked.
  assert.equal(own.counts.reads, 2);
  assert.equal(releases.counts.reads, 1);
  assert.equal(peer.counts.reads, 1);
  for (const read of [own, releases, peer]) read.unsubscribe();
  stop();
  client.clear();
});
