// Durable proof that a failed read of a repo's GitHub settings is not
// kept as "none": the host fails the merge-settings read when gh's call
// fails, rather than answering null (the UI's "every method allowed"),
// and asks gh again next time; the window asks again after a failure,
// keeps an answer for the host's hour, not the session, and a "gh not
// ready" null for half a minute.
//
// Drives the real host code against a fake gh on PATH whose GraphQL
// call fails until a marker file exists, as a network that comes back.
//
// Run: pnpm test github-metadata.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { QueryObserver } from "@tanstack/react-query";
import { afterAll, it, vi } from "vitest";
import { RemoteCallError } from "@shigomori/contracts/errors";
import type { RepoMergeConfig } from "@shigomori/contracts/schemas";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import { repoMergeConfigQueryOptions } from "@/hooks/githubCli/useRepoMergeConfig";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { queryKeysFor } from "@/lib/queryKeys";
import { createAppQueryClient } from "@/lib/queryClientOptions";
import { runHost } from "./lib/hostRuntime.mts";
import {
  installFakeGh,
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

const tracker = makeTracker();
afterAll(() => tracker.teardown());
scrubProcessGitEnv();
const root = tempDir("sm-gh-metadata-", tracker.track);
const online = join(root, "online");
installFakeGh(
  root,
  `#!/bin/sh
case "$*" in
  *"auth token"*) echo token;;
  *"api graphql"*)
    if [ -e "${online}" ]; then
      echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"autoMergeAllowed":true}}}'
    else
      echo "error connecting to api.github.com" >&2; exit 1
    fi;;
  *) exit 1;;
esac
`,
  tracker.track,
);
mkdirSync(join(root, "gh-config"));
writeFileSync(
  join(root, "gh-config", "hosts.yml"),
  "github.com:\n    user: me\n",
);

it("the host fails a merge-settings read gh could not make, and asks gh again next time", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = sandboxGit();
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
  const read = () =>
    runHost(
      Effect.flatMap(GithubCli, (cli) => cli.mergeConfig(repo)).pipe(
        Effect.result,
      ),
    );
  assert.ok(Result.isFailure(await read()), "an offline read answered");
  writeFileSync(online, "");
  const back = await read();
  assert.ok(Result.isSuccess(back));
  assert.deepEqual(back.success, {
    merge: false,
    squash: true,
    rebase: false,
    autoMerge: true,
  });
});

it("the window asks again after a failed read, keeps a not-ready null half a minute and an answer an hour, not the session", async () => {
  vi.useFakeTimers();
  try {
    let asks = 0;
    let answer: RepoMergeConfig | null | Error = new RemoteCallError({
      text: "error connecting to api.github.com",
      code: "1",
    });
    // oxlint-disable-next-line shigomori/no-double-cast -- a stand-in with the one call the query makes
    const api = {
      run: async () => {
        asks += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      githubCli: { repoMergeConfig: () => undefined },
    } as unknown as HostApi;
    // The app's retries, and kept while no page reads it, so only
    // staleness decides a re-read.
    const client = createAppQueryClient(() => undefined);
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, gcTime: Infinity },
    });
    const options = repoMergeConfigQueryOptions(api, queryKeysFor("d"), "p");
    const observe = () => {
      const observer = new QueryObserver(client, options);
      return observer.subscribe(() => {});
    };
    const first = observe();
    await vi.advanceTimersByTimeAsync(0);
    answer = null;
    // The default retries take it from there.
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(asks, 2, "a failed read was not asked again");
    assert.equal(client.getQueryData(options.queryKey), null);
    first();
    // A null (gh not ready) is asked again once its half minute is up,
    // and a page opening within it keeps it.
    const soon = observe();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(asks, 2);
    soon();
    answer = { merge: true, squash: true, rebase: true, autoMerge: false };
    await vi.advanceTimersByTimeAsync(31_000);
    const signedIn = observe();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(asks, 3, "a not-ready null was kept past its half minute");
    signedIn();
    // An answer stands for the hour, and past it the next page asks.
    const second = observe();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(asks, 3);
    second();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const third = observe();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(asks, 4, "an answer was kept past the hour");
    third();
    client.clear();
  } finally {
    vi.useRealTimers();
  }
});
