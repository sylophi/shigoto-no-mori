// An image a project's markdown names (a description, a pull request's,
// a file in a worktree) on one of the project's remotes' hosts, fetched
// by the device that holds the project and handed to the window as a
// data: URL. So no window loads from such a host itself: the desktop
// window's policy and the web client's static one name GitHub's image
// hosts alone, and this device, the one that knows the project's
// remotes, is the one owner of which other hosts may be read. Any other
// host is refused, so markdown can't make the device fetch from
// wherever it names.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Above this, an image is refused rather than carried over the wire.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT = "15 seconds";

export class RemoteImageError extends Schema.TaggedError<RemoteImageError>()(
  "RemoteImageError",
  {
    host: Schema.String,
    reason: Schema.Literals([
      "not-a-remote-host",
      "unreachable",
      "not-an-image",
      "too-large",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-remote-host":
        return `${this.host} is not a host of the project's remotes`;
      case "unreachable":
        return `the image couldn't be read from ${this.host}`;
      case "not-an-image":
        return `${this.host} answered with something other than an image`;
      case "too-large":
        return `the image on ${this.host} is too large to show`;
    }
  }
}

// A remote's host, lowercased, and its https port, or null for a remote
// that names no dotted host (a path, a file:// URL). Read as written,
// with none of gh's host folding (`ssh.` dropped), which would widen
// what may be fetched to a whole parent domain.
function remoteAuthority(
  remote: string,
): { readonly host: string; readonly port: string } | null {
  const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(?!\/\/)/.exec(remote);
  let host = scp?.[1];
  let port = "";
  if (host === undefined) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    host = url.hostname;
    if (url.protocol === "https:") port = url.port;
  }
  host = host.toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? { host, port } : null;
}

// Whether `url` is served over https by a remote's host or a subdomain
// of it (an Enterprise Server's media. and uploads.), on the default
// port or the one an https remote names.
export function isRemoteImageUrl(
  url: URL,
  remotes: readonly string[],
): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return remotes.some((remote) => {
    const authority = remoteAuthority(remote);
    return (
      authority !== null &&
      (host === authority.host || host.endsWith(`.${authority.host}`)) &&
      (url.port === "" || url.port === authority.port)
    );
  });
}

// Redirects followed, each checked as the first URL is: an attachment's
// to its media host stays on the remote's.
const MAX_REDIRECTS = 3;

export const fetchRemoteImage = Effect.fn("Projects.remoteImage")(function* (
  remotes: readonly string[],
  src: string,
  fetchImpl: typeof fetch = fetch,
) {
  let url = yield* Effect.try({
    try: () => new URL(src),
    catch: () =>
      new RemoteImageError({ host: "", reason: "not-a-remote-host" }),
  });
  const host = url.host;
  const unreachable = new RemoteImageError({ host, reason: "unreachable" });
  const tooLarge = new RemoteImageError({ host, reason: "too-large" });
  const refused = new RemoteImageError({ host, reason: "not-a-remote-host" });
  // One signal for every hop and its body, aborted however the read
  // ends: a timeout stops a body still coming, and a body left unread
  // (a redirect, a refusal) frees its connection.
  const done = new AbortController();
  const read = Effect.gen(function* () {
    for (let hop = 0; ; hop += 1) {
      if (!isRemoteImageUrl(url, remotes)) return yield* refused;
      const target = url;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(target, {
            signal: done.signal,
            redirect: "manual",
            headers: { accept: "image/*" },
          }),
        catch: () => unreachable,
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === MAX_REDIRECTS) return yield* unreachable;
        url = yield* Effect.try({
          try: () => new URL(location, target),
          catch: () => unreachable,
        });
        continue;
      }
      if (!response.ok) return yield* unreachable;
      const type = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (type === undefined || !type.startsWith("image/")) {
        return yield* new RemoteImageError({ host, reason: "not-an-image" });
      }
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
        return yield* tooLarge;
      }
      const bytes = yield* Effect.tryPromise({
        try: () => bodyUpTo(response, MAX_IMAGE_BYTES),
        catch: () => unreachable,
      });
      if (bytes === null) return yield* tooLarge;
      return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    }
  });
  return yield* read.pipe(
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT,
      orElse: () => Effect.fail(unreachable),
    }),
    Effect.ensuring(Effect.sync(() => done.abort())),
  );
});

// The body's bytes, or null once they pass `max`, read no further.
async function bodyUpTo(
  response: Response,
  max: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream's chunks come one after another
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // oxlint-disable-next-line no-await-in-loop -- once, as the read stops
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
