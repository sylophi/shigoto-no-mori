// Durable proof that a project's markdown images on a host other than
// GitHub's are read by the project's own device and handed to the
// window as data: URLs (host/lib/projects/remoteImage.ts), on that
// project's remotes' hosts alone: an Enterprise Server's own host, a
// subdomain of it, the default port or its https port, an ssh remote's
// host as written; never another host, plain http, another port, a
// remote that names no host, or a redirect off those hosts, which are
// refused before anything is fetched from there; and no body past the
// limit is read.
//
// Run: pnpm test remote-images.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { it } from "vitest";
import {
  fetchRemoteImage,
  isRemoteImageUrl,
  RemoteImageError,
} from "@host/lib/projects/remoteImage";
import { withSignedImages } from "@host/lib/githubCli/pullRequests";

const remotes = [
  "git@git.uni.example:lab/repo.git",
  "https://ghe.example.com:8443/team/repo.git",
];

it("an image on a remote's host or a subdomain of it, on the default port or an https remote's own, counts, and nothing else", () => {
  for (const src of [
    "https://git.uni.example/storage/a.png",
    "https://media.git.uni.example/user/1/a.png",
    "https://ghe.example.com:8443/storage/a.png",
    "https://media.ghe.example.com:8443/a.png",
    "https://media.ghe.example.com/a.png",
  ]) {
    assert.equal(isRemoteImageUrl(new URL(src), remotes), true, src);
  }
  for (const src of [
    "https://tracker.example/pixel.gif",
    "https://git.uni.example.evil.example/a.png",
    "http://git.uni.example/a.png",
    "https://git.uni.example:8443/a.png",
  ]) {
    assert.equal(isRemoteImageUrl(new URL(src), remotes), false, src);
  }
});

it("a remote that names no dotted host opens nothing, and an ssh. host is not folded into its parent domain", () => {
  for (const remote of [
    "file:///Volumes/backup/repo.git",
    "/Users/me/repo",
    "localhost:repo.git",
  ]) {
    for (const src of [
      "https://tracker.example./p.gif",
      "https://localhost./a.png",
      "https://tracker.example/p.gif",
    ]) {
      assert.equal(
        isRemoteImageUrl(new URL(src), [remote]),
        false,
        `${remote} ${src}`,
      );
    }
  }
  const ssh = ["git@ssh.corp.example:team/repo.git"];
  assert.equal(
    isRemoteImageUrl(new URL("https://ssh.corp.example/a.png"), ssh),
    true,
  );
  assert.equal(
    isRemoteImageUrl(new URL("https://vault.corp.example/a.png"), ssh),
    false,
  );
});

it("an Enterprise attachment the pull request body signs is one the device then reads", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const media = `https://media.ghe.example.com/user/7/files/${id}?token=signed`;
  const body = withSignedImages(
    `![shot](https://ghe.example.com:8443/user-attachments/assets/${id})`,
    `<p><img src="${media}"></p>`,
  );
  assert.equal(body, `![shot](${media})`);
  assert.equal(isRemoteImageUrl(new URL(media), remotes), true);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const read = (src: string, answer: () => Response) => {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    return answer();
  };
  return Effect.runPromise(
    fetchRemoteImage(remotes, src, fetchImpl).pipe(Effect.result),
  ).then((result) => ({ result, asked }));
};

it("reads an image on a remote's host as a data: URL, and refuses another host before fetching", async () => {
  const png = () =>
    new Response(PNG, { headers: { "content-type": "image/png" } });
  const ok = await read("https://git.uni.example/storage/a.png", png);
  assert.ok(Result.isSuccess(ok.result));
  assert.equal(ok.result.success, "data:image/png;base64,iVBORw==");
  const elsewhere = await read("https://tracker.example/pixel.gif", png);
  assert.deepEqual(elsewhere.asked, [], "fetched from a host it refuses");
  assert.ok(Result.isFailure(elsewhere.result));
  assert.ok(elsewhere.result.failure instanceof RemoteImageError);
  assert.equal(elsewhere.result.failure.reason, "not-a-remote-host");
});

it("follows a redirect only to another of the remotes' hosts", async () => {
  const png = new Response(PNG, { headers: { "content-type": "image/png" } });
  const hops: string[] = [];
  const via =
    (to: string): typeof fetch =>
    async (input) => {
      hops.push(String(input));
      return hops.length === 1
        ? new Response(null, { status: 302, headers: { location: to } })
        : png;
    };
  const media = await Effect.runPromise(
    fetchRemoteImage(
      remotes,
      "https://git.uni.example/a.png",
      via("https://media.git.uni.example/a.png"),
    ).pipe(Effect.result),
  );
  assert.ok(Result.isSuccess(media));
  hops.length = 0;
  const away = await Effect.runPromise(
    fetchRemoteImage(
      remotes,
      "https://git.uni.example/a.png",
      via("http://10.0.0.1/admin.png"),
    ).pipe(Effect.result),
  );
  assert.ok(Result.isFailure(away));
  assert.equal(away.failure.reason, "not-a-remote-host");
  assert.equal(hops.length, 1, "followed a redirect off the remotes' hosts");
});

it("stops reading a body that runs past the limit with no length said", async () => {
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1024 * 1024;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const huge = await read(
    "https://git.uni.example/big.png",
    () => new Response(endless, { headers: { "content-type": "image/png" } }),
  );
  assert.ok(Result.isFailure(huge.result));
  assert.equal(huge.result.failure.reason, "too-large");
  assert.ok(sent <= 12 * 1024 * 1024, `read ${sent} bytes`);
});

it("refuses an answer that is not an image, or too large to carry", async () => {
  const page = await read(
    "https://git.uni.example/login",
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
  );
  assert.ok(Result.isFailure(page.result));
  assert.equal(page.result.failure.reason, "not-an-image");
  const huge = await read(
    "https://git.uni.example/big.png",
    () =>
      new Response(PNG, {
        headers: {
          "content-type": "image/png",
          "content-length": String(64 * 1024 * 1024),
        },
      }),
  );
  assert.ok(Result.isFailure(huge.result));
  assert.equal(huge.result.failure.reason, "too-large");
});

it("ends its connection however the read ends: the signal every hop rode is aborted after", async () => {
  const signals: AbortSignal[] = [];
  const page: typeof fetch = async (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Response("<html>", { headers: { "content-type": "text/html" } });
  };
  await Effect.runPromise(
    fetchRemoteImage(remotes, "https://git.uni.example/login", page).pipe(
      Effect.result,
    ),
  );
  assert.equal(signals.length, 1);
  assert.equal(
    signals[0]?.aborted,
    true,
    "a body left unread kept its connection",
  );
});
