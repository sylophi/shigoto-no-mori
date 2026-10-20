// Durable proof for the per-project reads (a project's config, its
// icon, its GitHub description), which the sidebar and
// the projects page ask of every project at once: however many
// projects there are, one device never has more of them in flight than
// a third of the link's places (LINK_CALLS_IN_FLIGHT), so the page's
// own calls still go. A first run that turns terrier on lists every
// repo at once. A read that fails frees its place, and one device's
// reads never wait on another's.
//
// Run: pnpm test forest-reads.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import { LINK_CALLS_IN_FLIGHT } from "@shared/remote/rpcTransport";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { shigomoriConfigQueryOptions } from "@/hooks/config/useShigomoriConfig";
import { projectIconQueryOptions } from "@/hooks/projects/useProjectIcon";
import { repoDescriptionQueryOptions } from "@/hooks/projects/useRepoDescription";

// A host api whose three reads answer after a tick, counting how many
// are out at once.
function countingApi(fail: (projectId: string) => boolean = () => false) {
  const counts = { now: 0, peak: 0, calls: 0 };
  const answer = <A,>(projectId: string, value: A): Effect.Effect<A, unknown> =>
    Effect.promise(async () => {
      counts.now += 1;
      counts.calls += 1;
      counts.peak = Math.max(counts.peak, counts.now);
      await new Promise((resolve) => setTimeout(resolve, 5));
      counts.now -= 1;
      if (fail(projectId)) throw new Error(`no ${projectId}`);
      return value;
    });
  const api = {
    run: (effect) => Effect.runPromise(effect),
    githubCli: {
      repoDescription: ({ projectId }: { projectId: string }) =>
        answer(projectId, null),
    },
    shigomori: {
      read: ({ projectId }: { projectId: string }) => answer(projectId, null),
    },
    projects: {
      icon: ({ projectId }: { projectId: string }) => answer(projectId, null),
    },
  } as HostApi;
  return { api, counts };
}

// Every per-project read the sidebar and the projects page make for each
// of `projects`, at once.
const readAll = (api: HostApi, deviceId: string, projects: number) =>
  Promise.allSettled(
    Array.from({ length: projects }, (_, index) => `p${index}`).flatMap(
      (projectId) =>
        [
          shigomoriConfigQueryOptions(projectId, { deviceId, api }),
          projectIconQueryOptions(projectId, { deviceId, api }),
          repoDescriptionQueryOptions(projectId, { deviceId, api }),
        ].map((options) => {
          const read = options.queryFn as (context: {
            signal: AbortSignal;
          }) => Promise<unknown>;
          return read({ signal: new AbortController().signal });
        }),
    ),
  );

it("keeps a forest's reads to a third of the link's places", async () => {
  const { api, counts } = countingApi();
  const results = await readAll(api, "device-a", 60);
  assert.equal(counts.calls, 180);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(counts.peak, LINK_CALLS_IN_FLIGHT / 3);
});

it("frees a failed read's place", async () => {
  const { api, counts } = countingApi((projectId) => projectId.endsWith("3"));
  const results = await readAll(api, "device-b", 40);
  const failed = results.filter((result) => result.status === "rejected");
  // p3, p13, p23 and p33, each three times.
  assert.equal(failed.length, 12);
  assert.equal(counts.calls, 120);
  assert.ok(counts.peak <= LINK_CALLS_IN_FLIGHT / 3);
});

it("gives each device its own share", async () => {
  const one = countingApi();
  const two = countingApi();
  await Promise.all([
    readAll(one.api, "device-c", 30),
    readAll(two.api, "device-d", 30),
  ]);
  assert.equal(one.counts.peak, LINK_CALLS_IN_FLIGHT / 3);
  assert.equal(two.counts.peak, LINK_CALLS_IN_FLIGHT / 3);
});
