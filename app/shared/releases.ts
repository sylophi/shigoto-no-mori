// The app's changelog, read from its GitHub releases: the notes each
// release was published with are the changelog, so there is no second
// copy to keep in step. Pure, over an injected fetch, so the desktop
// binding (main, node's fetch) and the web one (the page's) serve the
// same answer, and a check can drive it with a stub.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { APP_REPO } from "@shigomori/engine/flavor";
import {
  isRateLimited,
  RELEASE_LIST_URL,
  ReleaseList,
  trimV,
} from "@shigomori/engine/updateFeed";
import type { Release } from "@shigomori/contracts/schemas";

export const RELEASES_PAGE_URL = `https://github.com/${APP_REPO}/releases`;

const decodeReleaseList = Schema.decodeUnknownResult(ReleaseList);

// The refusal for the hourly limit. It reaches the renderer as a
// message (an untyped error crosses as its text), where a retry waits on it.
export const RATE_LIMITED =
  "GitHub is rate-limiting requests from this network. Try again later.";

export async function fetchReleases(
  fetchImpl: typeof fetch = fetch,
): Promise<Release[]> {
  let response: Response;
  try {
    response = await fetchImpl(RELEASE_LIST_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new Error("Couldn't reach GitHub.");
  }
  if (
    isRateLimited(
      response.status,
      response.headers.get("x-ratelimit-remaining") ?? undefined,
    )
  ) {
    throw new Error(RATE_LIMITED);
  }
  if (!response.ok) {
    throw new Error(`GitHub answered HTTP ${response.status}.`);
  }
  const parsed = decodeReleaseList(await response.json());
  if (Result.isFailure(parsed)) {
    throw new Error("GitHub answered with a release list this app can't read.");
  }
  return (parsed.success ?? []).flatMap((release) =>
    release === null || !release.tag_name || release.draft === true
      ? []
      : [
          {
            version: trimV(release.tag_name),
            notes: release.body ?? "",
            publishedAt: release.published_at ?? null,
            prerelease: release.prerelease ?? false,
            url: release.html_url || RELEASES_PAGE_URL,
          },
        ],
  );
}
