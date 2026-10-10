// The app's changelog, read from its GitHub releases: the notes each
// release was published with are the changelog, so there is no second
// copy to keep in step. Pure, over an injected fetch, so the desktop
// binding (main, node's fetch) and the web one (the page's) serve the
// same answer, and a check can drive it with a stub.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { UPDATE_FEED_REPO } from "@shared/packaging/updateFeed.mts";
import type { Release } from "@shigomori/contracts/schemas";

export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_FEED_REPO}/releases`;

// The API's page maximum, and the engine's release list reads the
// same one page (updateFeed.ts). Older releases are a click away on GitHub.
const RELEASE_LIST_URL = `https://api.github.com/repos/${UPDATE_FEED_REPO}/releases?per_page=100`;

// The fields read off each entry. Drafts never reach an
// unauthenticated caller, but the flag is dropped on the floor anyway
// rather than trusted to stay that way.
const GitHubReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  prerelease: Schema.Boolean,
  draft: Schema.optional(Schema.Boolean),
  html_url: Schema.String,
});
const decodeReleaseList = Schema.decodeUnknownResult(
  Schema.Array(GitHubReleaseSchema),
);

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
  // Unauthenticated calls get 60 an hour per address. GitHub spends
  // that budget with a 403 that says so, and 429 is its secondary
  // limit (the same reading as the engine's updateFeed.ts).
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
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
  return parsed.success
    .filter((release) => release.draft !== true)
    .map((release) => ({
      version: release.tag_name.replace(/^v/, ""),
      notes: release.body ?? "",
      publishedAt: release.published_at ?? null,
      prerelease: release.prerelease,
      url: release.html_url,
    }));
}
