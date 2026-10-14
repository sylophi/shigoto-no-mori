// The updater's feeds: the release list and the update feed, and the release this build is offered.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { type Flavor, flavorNames } from "../flavor.ts";
import { parse } from "semver";
import {
  FeedAnswer,
  isRateLimited,
  parseReleaseDate,
  parseRfc3339,
  pickRelease,
  rateLimitReset,
  ReleaseList,
  ReleaseListCache,
  type ReleaseInfo,
  trimV,
} from "../updateFeed.ts";
import {
  BadUpdateUrl,
  FEED_BODY_LIMIT,
  FEED_TIMEOUT,
  type Kept,
  RELEASE_LIST_BODY_LIMIT,
  RELEASE_LIST_MAX_AGE,
  RateLimited,
  type UpdateInput,
  ZERO_VERSION,
  bodyText,
  discard,
  feedFailed,
  feedRequest,
  header,
  isBadUrl,
  releaseListUrl,
  updateServerUrl,
  within,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";

const releasesOf = (body: unknown) =>
  Schema.decodeUnknownEffect(ReleaseList)(body).pipe(
    Effect.map((releases) => releases ?? []),
    Effect.mapError((cause) =>
      feedFailed("release-list")("malformed", { cause }),
    ),
  );

export const makeFeeds = ({
  flavor,
  files,
}: {
  readonly flavor: Flavor;
  readonly files: FilesArea;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    // Which releases this build is offered, none for dev.
    const offered = flavorNames(flavor).updates;

    const releaseListPath = files.at.releaseList;
    const { readShared, writeShared } = files;
    // --- the feeds ---

    // A request's answer, or why there is none: `unreachable` for anything
    // but a URL no request can be made to. It carries the headers Go's sm sent
    // and no trace ids, since it leaves for GitHub.
    const send = <E>(
      request: HttpClientRequest.HttpClientRequest,
      deadline: number,
      unreachable: (cause: unknown) => E,
    ) =>
      within(
        http
          .execute(request)
          .pipe(
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          ),
        deadline,
      ).pipe(
        Effect.mapError((cause) =>
          HttpClientError.isHttpClientError(cause) && isBadUrl(cause)
            ? new BadUpdateUrl({ cause })
            : unreachable(cause),
        ),
      );

    // The update server compares versions and answers 204 when nothing is
    // newer. This build's version is in the URL, so any other answer but
    // 200 means a broken feed, not a missing update.
    const queryUpdateServer = Effect.fn("Updater.queryUpdateServer")(function* (
      input: UpdateInput,
    ) {
      const { running } = input;
      const url = updateServerUrl(input);
      const failed = feedFailed("update-server");
      const deadline =
        (yield* Clock.currentTimeMillis) + Duration.toMillis(FEED_TIMEOUT);
      const response = yield* send(
        feedRequest(url, running),
        deadline,
        (cause) => failed("unreachable", { cause }),
      );
      if (response.status !== 200) yield* discard(response, deadline);
      if (response.status === 204) return undefined;
      if (response.status !== 200) {
        return yield* failed("status", { status: response.status });
      }
      const answer = yield* within(
        bodyText(response, FEED_BODY_LIMIT).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(FeedAnswer)),
          ),
        ),
        deadline,
      ).pipe(Effect.mapError((cause) => failed("malformed", { cause })));
      const zip = answer?.url ?? "";
      const version = trimV(answer?.name ?? "");
      if (zip === "" || version === "") return yield* failed("incomplete");
      return {
        url: zip,
        version,
        notes: answer?.notes ?? "",
        releaseDate: parseReleaseDate(answer?.pub_date ?? ""),
      } satisfies ReleaseInfo;
    });

    // The kept copy of the release list, when it came from `url`.
    const readReleaseListCache = (url: string) =>
      readShared(releaseListPath, (value): Option.Option<Kept> => {
        const cache = Schema.decodeUnknownOption(ReleaseListCache)(value);
        if (Option.isNone(cache) || cache.value.url !== url)
          return Option.none();
        const { fetchedAt, etag = "", retryAt, body } = cache.value;
        const fetched = parseRfc3339(fetchedAt);
        return body === undefined || fetched === undefined
          ? Option.none()
          : Option.some({
              url,
              fetchedAt: fetched,
              etag,
              retryAt: parseRfc3339(retryAt ?? "") ?? 0,
              body,
            });
      });

    // Best effort: a copy that can't be written only costs the next check
    // a full request.
    const keepReleaseList = (kept: Kept, pid: number) =>
      writeShared(
        releaseListPath,
        `${JSON.stringify(
          {
            url: kept.url,
            fetchedAt: new Date(kept.fetchedAt).toISOString(),
            ...(kept.etag === "" ? {} : { etag: kept.etag }),
            retryAt: new Date(kept.retryAt).toISOString(),
            body: kept.body,
          },
          null,
          2,
        )}\n`,
        pid,
      ).pipe(Effect.ignore);

    // The release list, and whether the API confirmed it this run rather
    // than the kept copy answering. Within RELEASE_LIST_MAX_AGE the copy
    // answers on its own. After that the request carries its ETag (a 304
    // is free of the rate limit). While the API says the hourly budget is
    // spent, the copy answers until the reset, stale by at most an hour,
    // rather than an error in Settings.
    const fetchReleaseList = Effect.fn("Updater.fetchReleaseList")(function* (
      input: UpdateInput,
    ) {
      const { running } = input;
      const url = releaseListUrl(input);
      const failed = feedFailed("release-list");
      const cached = Option.getOrUndefined(yield* readReleaseListCache(url));
      const now = yield* Clock.currentTimeMillis;
      if (
        cached !== undefined &&
        (now < cached.fetchedAt + RELEASE_LIST_MAX_AGE || now < cached.retryAt)
      ) {
        return { releases: yield* releasesOf(cached.body), confirmed: false };
      }
      const request = feedRequest(url, running).pipe(
        HttpClientRequest.setHeaders({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(cached !== undefined && cached.etag !== ""
            ? { "If-None-Match": cached.etag }
            : {}),
        }),
      );
      const deadline = now + Duration.toMillis(FEED_TIMEOUT);
      const response = yield* send(request, deadline, (cause) =>
        failed("unreachable", { cause }),
      );
      if (response.status !== 200) yield* discard(response, deadline);
      if (response.status === 304 && cached !== undefined) {
        yield* keepReleaseList(
          { ...cached, fetchedAt: now, retryAt: 0 },
          running.pid,
        );
        return { releases: yield* releasesOf(cached.body), confirmed: true };
      }
      if (
        isRateLimited(
          response.status,
          header(response, "x-ratelimit-remaining"),
        )
      ) {
        const retryAt = rateLimitReset(
          {
            reset: header(response, "x-ratelimit-reset"),
            retryAfter: header(response, "retry-after"),
          },
          now,
        );
        if (cached === undefined) return yield* new RateLimited({ retryAt });
        yield* keepReleaseList({ ...cached, retryAt }, running.pid);
        return { releases: yield* releasesOf(cached.body), confirmed: false };
      }
      if (response.status !== 200) {
        return yield* failed("status", { status: response.status });
      }
      const text = yield* within(
        bodyText(response, RELEASE_LIST_BODY_LIMIT),
        deadline,
      ).pipe(Effect.mapError((cause) => failed("unreadable", { cause })));
      const body = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) => failed("malformed", { cause }),
      });
      const releases = yield* releasesOf(body);
      yield* keepReleaseList(
        {
          url,
          fetchedAt: now,
          etag: header(response, "etag") ?? "",
          retryAt: 0,
          body,
        },
        running.pid,
      );
      return { releases, confirmed: true };
    });

    // The release to move to (undefined: nothing newer), and whether the
    // answer came from the network this run. An answer from the kept
    // release list is unconfirmed: it can lag a release an earlier run
    // already staged, so it never counts as "up to date" for anything
    // destructive. The release list is ranked against this build's
    // version (the release workflow stamps the tag into the build, so
    // v2.0.0-beta.2 runs as "2.0.0-beta.2"). When GitHub can't answer,
    // the update server compares instead, but its "nothing newer" can't
    // speak for a prerelease build's channel, so for one it is
    // unconfirmed too. When both fail, the release list's error is the
    // one reported.
    const queryFeed = Effect.fn("Updater.queryFeed")(function* (
      input: UpdateInput,
    ) {
      const current = parse(input.running.version) ?? ZERO_VERSION;
      const fromList = Effect.map(
        fetchReleaseList(input),
        ({ releases, confirmed }) => ({
          release: pickRelease(
            current,
            releases,
            input.running.arch,
            offered ?? "releases",
          ),
          confirmed,
        }),
      );
      const fromServer = Effect.map(queryUpdateServer(input), (release) => ({
        release,
        confirmed: current.prerelease.length === 0,
      }));
      // The update server knows no v3 line: a v3 build asks GitHub
      // alone.
      if (offered === "v3") return yield* fromList;
      if (releaseListUrl(input) === "") return yield* fromServer;
      if (updateServerUrl(input) === "") return yield* fromList;
      return yield* fromList.pipe(
        Effect.catch((listFailure) =>
          fromServer.pipe(Effect.mapError(() => listFailure)),
        ),
      );
    });

    return { send, queryFeed };
  });

export type FeedsArea = Effect.Success<ReturnType<typeof makeFeeds>>;
