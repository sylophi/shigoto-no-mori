// The updater through its service, where a port can brick an install. The
// network is a fake HTTP client and time is the test clock. The commands
// it runs are real (ditto, xattr, ps) but for stand-ins on PATH that pose
// as codesign with a team of our choosing, as the app's processes (ps,
// pgrep), and as `open`, so nothing is ever launched. A filesystem that
// fails or stalls a chosen rename drives the swap through every step it
// can stop at.
import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "vitest";
import { errorDocument } from "../src/errorDocument.ts";
import type { Flavor } from "../src/flavor.ts";
import * as Paths from "../src/Paths.ts";
import * as Updater from "../src/Updater.ts";

// Real paths, as the updater resolves its own binary through links.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "engine-updater-")));
const bin = join(scratch, "bin");
// What the stand-ins read and record.
const control = join(scratch, "control");
const zips = join(scratch, "zips");
const originalPath = process.env.PATH;

const script = (name: string, body: string) =>
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

beforeAll(() => {
  mkdirSync(bin);
  mkdirSync(zips);
  // A bundle's team is its Contents/TEAM file, none for an ad hoc
  // signature, and Contents/UNSIGNED fails verification. With
  // control/real-codesign the real one answers.
  script(
    "codesign",
    `echo "codesign $*" >> "${control}/calls"
[ -e "${control}/real-codesign" ] && exec /usr/bin/codesign "$@"
if [ "$1" = "--verify" ]; then
  if [ -e "$5/Contents/UNSIGNED" ]; then echo "$5: code object is not signed at all" >&2; exit 1; fi
  exit 0
fi
if [ "$1" = "-dvv" ]; then
  echo "Executable=$3/Contents/MacOS/x" >&2
  if [ -e "$3/Contents/TEAM" ]; then echo "TeamIdentifier=$(cat "$3/Contents/TEAM")" >&2
  else echo "TeamIdentifier=not set" >&2; fi
  exit 0
fi
exit 2`,
  );
  // The pids in control/app-pids are the app.
  script(
    "ps",
    `if [ "$1" = "-o" ] && [ "$2" = "comm=" ] && grep -qx "$4" "${control}/app-pids" 2>/dev/null; then
  echo "/Applications/Shigoto no Mori.app/Contents/MacOS/Shigoto no Mori"; exit 0
fi
exec /bin/ps "$@"`,
  );
  script("pgrep", `[ -e "${control}/app-running" ]`);
  script(
    "open",
    `echo "open $*" >> "${control}/calls"
[ ! -e "${control}/open-fails" ]`,
  );
  // Copies (not extractions) fail with control/ditto-fails.
  script(
    "ditto",
    `if [ -e "${control}/ditto-fails" ] && [ "$1" != "-x" ]; then echo "ditto: no space left" >&2; exit 1; fi
exec /usr/bin/ditto "$@"`,
  );
  process.env.PATH = `${bin}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(scratch, { recursive: true, force: true });
});

const children: ChildProcess[] = [];
beforeEach(() => {
  rmSync(control, { recursive: true, force: true });
  mkdirSync(control);
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

const touch = (name: string, text = "") =>
  writeFileSync(join(control, name), text);

const calls = () =>
  existsSync(join(control, "calls"))
    ? readFileSync(join(control, "calls"), "utf8").trim().split("\n")
    : [];

// A process that stays alive until the test ends, and one already gone.
const livePid = () => {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  children.push(child);
  assert.ok(child.pid);
  return child.pid;
};
const deadPid = () => {
  const { pid } = spawnSync("true");
  assert.ok(pid);
  return pid;
};

// --- bundles and zips ---

const APP = "Shigoto no Mori.app";

type BundleOptions = {
  readonly team?: string | null;
  readonly unsigned?: boolean;
};

const makeBundle = (
  at: string,
  version: string,
  { team = "TEAM1", unsigned = false }: BundleOptions = {},
) => {
  mkdirSync(join(at, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(at, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(at, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>x</string><key>CFBundleIdentifier</key><string>test.shigomori</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
`,
  );
  writeFileSync(join(at, "Contents", "MacOS", "x"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  writeFileSync(join(at, "Contents", "Resources", "sm"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  writeFileSync(join(at, "Contents", "Resources", "version"), version);
  if (team !== null) writeFileSync(join(at, "Contents", "TEAM"), team);
  if (unsigned) writeFileSync(join(at, "Contents", "UNSIGNED"), "");
  return at;
};

let zipCount = 0;
// A release zip as the zip maker builds it: the bundles at its top.
const zipOf = (
  bundles: ReadonlyArray<
    { readonly name?: string; readonly version: string } & BundleOptions
  >,
) => {
  const dir = join(zips, `z${zipCount++}`);
  mkdirSync(dir);
  for (const bundle of bundles) {
    makeBundle(join(dir, bundle.name ?? APP), bundle.version, bundle);
  }
  const zip = `${dir}.zip`;
  execFileSync("/usr/bin/ditto", ["-c", "-k", dir, zip]);
  return new Uint8Array(readFileSync(zip));
};

// --- the fake network ---

type Answer = Response | "unreachable" | undefined;
// An answer, or one the test holds back until it says so.
type Route = (
  url: URL,
  request: HttpClientRequest.HttpClientRequest,
) => Answer | Effect.Effect<Answer>;

const network = (route: Route) => {
  const seen: Array<{
    readonly url: string;
    readonly headers: Record<string, string>;
  }> = [];
  const client = HttpClient.make((request, url) => {
    seen.push({ url: url.toString(), headers: { ...request.headers } });
    const routed = route(url, request);
    return (Effect.isEffect(routed) ? routed : Effect.succeed(routed)).pipe(
      Effect.flatMap((answer) =>
        answer === "unreachable"
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("connection refused"),
                }),
              }),
            )
          : Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                answer ?? new Response(null, { status: 404 }),
              ),
            ),
      ),
    );
  });
  return { client, seen };
};

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

const FEED =
  "https://update.electronjs.org/sylophi/shigoto-no-mori/darwin-arm64/";
const LIST =
  "https://api.github.com/repos/sylophi/shigoto-no-mori/releases?per_page=100";
const zipUrl = (version: string) => `https://example.test/${version}.zip`;

// The update server answering `version` (none: 204), with its zip.
const serverFor =
  (version: string | undefined, zip?: Uint8Array) =>
  (url: URL): Answer => {
    if (url.toString().startsWith(FEED)) {
      return version === undefined
        ? new Response(null, { status: 204 })
        : json({
            url: zipUrl(version),
            name: `v${version}`,
            notes: `notes for ${version}`,
            pub_date: "2026-09-15T12:00:00Z",
          });
    }
    if (version !== undefined && zip && url.toString() === zipUrl(version)) {
      return new Response(zip);
    }
    return undefined;
  };

// A release as GitHub lists it, with its zip for arm64.
const listed = (tag: string) => ({
  tag_name: tag,
  prerelease: tag.includes("-"),
  body: `notes for ${tag}`,
  published_at: "2026-09-15T12:00:00Z",
  assets: [
    {
      name: `Shigoto.no.Mori-darwin-arm64-${tag.slice(1)}.zip`,
      browser_download_url: zipUrl(tag.slice(1)),
    },
  ],
});

// --- a home with the app installed ---

type Box = {
  readonly root: string;
  readonly dataDir: string;
  readonly installed: string;
  readonly updates: string;
};

const newBox = (version = "1.0.0", options: BundleOptions = {}): Box => {
  const root = mkdtempSync(join(scratch, "box-"));
  const installed = join(root, "Applications", APP);
  makeBundle(installed, version, options);
  const dataDir = join(root, "data");
  return { root, dataDir, installed, updates: join(dataDir, "updates") };
};

const running = (box: Box, version = "1.0.0"): Updater.Running => ({
  version,
  arch: "arm64",
  executable: join(box.installed, "Contents", "Resources", "sm"),
  pid: process.pid,
});

const versionAt = (bundle: string) =>
  readFileSync(join(bundle, "Contents", "Resources", "version"), "utf8");

// A filesystem whose renames `fault` may fail or hold up.
type Fault = (
  from: string,
  to: string,
) => Effect.Effect<void, PlatformError.PlatformError> | undefined;

type Setup = {
  readonly box: Box;
  readonly http: HttpClient.HttpClient;
  readonly flavor?: Flavor;
  readonly fault?: Fault;
};

const layerFor = ({ box, http, flavor = "prod", fault }: Setup) =>
  Updater.layer(flavor).pipe(
    Layer.provideMerge(Paths.layer("prod")),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(
      fault === undefined
        ? Layer.empty
        : Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (fs) => ({
              ...fs,
              rename: (from: string, to: string) => {
                const faulted = fault(from, to);
                return faulted === undefined
                  ? fs.rename(from, to)
                  : faulted.pipe(Effect.andThen(fs.rename(from, to)));
              },
            })),
          ).pipe(Layer.provide(NodeFileSystem.layer)),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { HOME: box.root, SHIGOMORI_DATA_DIR: box.dataDir },
        }),
      ),
    ),
  );

// The service's answer under the test clock, set to now.
const using = <A, E>(
  setup: Setup,
  body: (updater: Updater.Updater["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      return yield* body(yield* Updater.Updater);
    }).pipe(Effect.provide(Layer.merge(layerFor(setup), TestClock.layer()))),
  );

// The failure `body` ends in.
const failure = <A, E>(
  setup: Setup,
  body: (updater: Updater.Updater["Service"]) => Effect.Effect<A, E>,
) => using(setup, (updater) => Effect.flip(body(updater)));

// The failure's words as `sm --json` prints them.
const words = (error: unknown) => errorDocument(error).error;

// Moves the test clock on a step at a time until `fiber` is done, giving
// the real files and processes it waits on a moment between steps.
const driven = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  step: Duration.Input = "1 second",
) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust(step);
      yield* TestClock.withLive(Effect.sleep("3 millis"));
    }
    return yield* Fiber.join(fiber);
  });

// Waits until `condition` holds, for a test that acts mid-run. The clock
// stays put, so what the run stamps is still now.
const until = (condition: () => boolean, step?: Duration.Input) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000 && !condition(); i++) {
      if (step !== undefined) yield* TestClock.adjust(step);
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    assert.ok(condition(), "never got there");
  });

const progressLog = () => {
  const seen: Updater.Progress[] = [];
  return {
    seen,
    progress: (progress: Updater.Progress) =>
      Effect.sync(() => void seen.push(progress)),
  };
};

const staged = (box: Box) => join(box.updates, "staged");

const manifestOf = (box: Box) =>
  JSON.parse(
    readFileSync(join(staged(box), "manifest.json"), "utf8"),
  ) as unknown;

// A bundle left in updates/staged, as a finished stage leaves it.
const seedStaged = (box: Box, version: string, options: BundleOptions = {}) => {
  makeBundle(join(staged(box), APP), version, options);
  writeFileSync(
    join(staged(box), "manifest.json"),
    JSON.stringify({ version, bundleName: APP }),
  );
};

// ---------------------------------------------------------------------------

describe("a dev build", () => {
  it("has no update channel, whatever it is asked", async () => {
    const box = newBox();
    const { client, seen } = network(() => undefined);
    const setup = { box, http: client, flavor: "dev" as const };
    const input = { running: running(box) };
    for (const error of [
      await failure(setup, (u) => u.check(input)),
      await failure(setup, (u) => u.stage(input)),
      await failure(setup, (u) => u.update(input)),
      await failure(setup, (u) =>
        u.finishInstall({ running: running(box), appPid: 1 }),
      ),
    ]) {
      assert.ok(error instanceof Updater.UpdatesUnavailable);
      assert.equal(
        words(error),
        "This is the dev CLI. Dev builds have no update channel. Pull the checkout instead.",
      );
    }
    assert.equal(seen.length, 0);
  });
});

describe("the update server", () => {
  it("asks for this build and arch, and reads 204 as up to date", async () => {
    const box = newBox();
    const { client, seen } = network(serverFor(undefined));
    const { seen: steps, progress } = progressLog();
    const doc = await using({ box, http: client }, (u) =>
      u.check({ running: running(box), progress }),
    );
    assert.deepEqual(doc, { ok: true, status: "up-to-date", version: "1.0.0" });
    assert.deepEqual(seen, [
      {
        url: `${FEED}1.0.0`,
        headers: { "user-agent": "shigoto-no-mori-cli/1.0.0" },
      },
    ]);
    assert.deepEqual(steps, [{ phase: "checking" }]);
  });

  it("names the release ahead", async () => {
    const box = newBox();
    const { client } = network(serverFor("1.2.0"));
    assert.deepEqual(
      await using({ box, http: client }, (u) =>
        u.check({ running: running(box) }),
      ),
      {
        ok: true,
        status: "update-available",
        version: "1.2.0",
        installed: "1.0.0",
      },
    );
  });

  it("fails on any other answer, in Go's words", async () => {
    const box = newBox();
    const errorFor = (answer: Answer, feedUrl?: string) =>
      failure({ box, http: network(() => answer).client }, (u) =>
        u.check({ running: running(box), feedUrl }),
      ).then(words);
    assert.equal(
      await errorFor(new Response(null, { status: 500 })),
      "The update feed answered HTTP 500.",
    );
    assert.equal(
      await errorFor(new Response(null, { status: 404 })),
      "The update feed answered HTTP 404.",
    );
    assert.equal(
      await errorFor(json({ name: "v2.0.0" })),
      "The update feed answered without a release URL or name.",
    );
    assert.equal(
      await errorFor(json({ url: "https://x", name: "v" })),
      "The update feed answered without a release URL or name.",
    );
    assert.match(
      await errorFor(new Response("{nope")),
      /^The update feed answered malformed JSON: /,
    );
    assert.match(
      await errorFor(json({ url: 5 })),
      /^The update feed answered malformed JSON: /,
    );
    // Nothing past a megabyte is read, so a longer answer is cut short.
    assert.match(
      await errorFor(
        json({ notes: "x".repeat(2 << 20), url: "u", name: "v2" }),
      ),
      /^The update feed answered malformed JSON: /,
    );
    assert.equal(
      await errorFor("unreachable"),
      `Couldn't reach the update feed: Transport error (GET ${FEED}1.0.0): connection refused`,
    );
    assert.match(
      await errorFor(undefined, "http://[::1"),
      /^Bad update URL "http:\/\/\[::1": /,
    );
  });

  it("is what a stand-in answers for, prerelease build or not", async () => {
    const box = newBox();
    const { client, seen } = network((url) =>
      url.hostname === "stand.in"
        ? new Response(null, { status: 204 })
        : undefined,
    );
    const doc = await using({ box, http: client }, (u) =>
      u.check({
        running: running(box, "2.0.0-beta.2"),
        feedUrl: "https://stand.in/feed",
      }),
    );
    assert.equal(doc.status, "up-to-date");
    assert.deepEqual(
      seen.map((request) => request.url),
      ["https://stand.in/feed"],
    );
  });
});

describe("the release list", () => {
  const prerelease = (box: Box) => running(box, "2.0.0-beta.2");

  it("is what a prerelease build follows, in its own channel", async () => {
    const box = newBox("2.0.0-beta.2");
    const { client, seen } = network((url) =>
      url.toString() === LIST
        ? json([
            listed("v2.0.0-beta.3"),
            listed("v2.0.0-beta.2"),
            listed("v1.7.1"),
          ])
        : undefined,
    );
    assert.deepEqual(
      await using({ box, http: client }, (u) =>
        u.check({ running: prerelease(box) }),
      ),
      {
        ok: true,
        status: "update-available",
        version: "2.0.0-beta.3",
        installed: "2.0.0-beta.2",
      },
    );
    assert.deepEqual(seen[0]?.headers, {
      "user-agent": "shigoto-no-mori-cli/2.0.0-beta.2",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    });
  });

  it("is never asked by a full release build", async () => {
    const box = newBox();
    const { client, seen } = network(serverFor(undefined));
    await using({ box, http: client }, (u) =>
      u.check({ running: running(box) }),
    );
    assert.ok(seen.every((request) => request.url.startsWith(FEED)));
  });

  it("answers from a recent copy, then asks again with its ETag", async () => {
    const box = newBox();
    let status = 200;
    const { client, seen } = network((url, request) => {
      if (url.toString() !== LIST) return undefined;
      if (status === 200 && request.headers["if-none-match"] === '"v1"') {
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      return json([listed("v2.0.0-beta.3")], { headers: { etag: '"v1"' } });
    });
    const check = (u: Updater.Updater["Service"]) =>
      u.check({ running: prerelease(box) });
    await using({ box, http: client }, (u) =>
      Effect.gen(function* () {
        yield* check(u);
        assert.equal(seen.length, 1);
        // Within 15 minutes the copy answers alone.
        yield* TestClock.adjust("14 minutes");
        assert.equal((yield* check(u)).version, "2.0.0-beta.3");
        assert.equal(seen.length, 1);
        // Then a request carrying the ETag, which a 304 answers.
        yield* TestClock.adjust("2 minutes");
        assert.equal((yield* check(u)).version, "2.0.0-beta.3");
        assert.equal(seen.length, 2);
        assert.equal(seen[1]?.headers["if-none-match"], '"v1"');
        // The 304 counts as fresh.
        yield* TestClock.adjust("10 minutes");
        yield* check(u);
        assert.equal(seen.length, 2);
      }),
    );
  });

  it("keeps answering from the copy while GitHub rate-limits", async () => {
    const box = newBox();
    let limited = false;
    const { client, seen } = network((url) => {
      if (url.toString() !== LIST) return undefined;
      if (!limited) return json([listed("v2.0.0-beta.3")]);
      return new Response(null, {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 40 * 60),
        },
      });
    });
    const check = (u: Updater.Updater["Service"]) =>
      u.check({ running: prerelease(box) });
    await using({ box, http: client }, (u) =>
      Effect.gen(function* () {
        yield* check(u);
        limited = true;
        yield* TestClock.adjust("16 minutes");
        assert.equal((yield* check(u)).version, "2.0.0-beta.3");
        assert.equal(seen.length, 2);
        // The reset time is kept: no request until it passes.
        yield* TestClock.adjust("20 minutes");
        yield* check(u);
        assert.equal(seen.length, 2);
        yield* TestClock.adjust("5 minutes");
        yield* check(u);
        assert.equal(seen.length, 3);
      }),
    );
  });

  it("fails on a refusal, and on a rate limit with no copy", async () => {
    const box = newBox();
    const errorFor = (response: () => Response) =>
      failure({ box, http: network(() => response()).client }, (u) =>
        u.check({ running: prerelease(box) }),
      );
    // A 403 without the header is a refusal.
    assert.equal(
      words(await errorFor(() => new Response(null, { status: 403 }))),
      "The release list answered HTTP 403.",
    );
    const reset = Date.now() + 30 * 60_000;
    const limited = await errorFor(
      () =>
        new Response(null, {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(reset / 1000)),
          },
        }),
    );
    assert.ok(limited instanceof Updater.RateLimited);
    const at = new Date(Math.floor(reset / 1000) * 1000);
    const hours = at.getHours() % 12 === 0 ? 12 : at.getHours() % 12;
    assert.equal(
      words(limited),
      `GitHub is rate-limiting update checks from this address until ${hours}:${String(at.getMinutes()).padStart(2, "0")}${at.getHours() < 12 ? "AM" : "PM"}.`,
    );
    assert.ok(
      (await errorFor(() => new Response(null, { status: 429 }))) instanceof
        Updater.RateLimited,
    );
    assert.match(
      words(await errorFor(() => new Response("[{"))),
      /^The release list is malformed JSON: /,
    );
  });

  it("never lets one endpoint's copy answer for another", async () => {
    const box = newBox();
    const answer = (tag: string) =>
      network((url) =>
        url.hostname === "api.github.com" || url.hostname === "stand.in"
          ? json([listed(tag)])
          : undefined,
      );
    await using({ box, http: answer("v2.0.0-beta.99").client }, (u) =>
      u.check({ running: prerelease(box) }),
    );
    const other = answer("v2.0.0-beta.3");
    const doc = await using({ box, http: other.client }, (u) =>
      u.check({
        running: prerelease(box),
        releasesUrl: "https://stand.in/list",
      }),
    );
    assert.equal(doc.version, "2.0.0-beta.3");
    assert.equal(other.seen.length, 1);
  });

  it("answers from a copy the Go sm wrote", async () => {
    const box = newBox();
    mkdirSync(box.updates, { recursive: true });
    const fetched = new Date(Date.now() - 60_000);
    writeFileSync(
      join(box.updates, "release-list.json"),
      `{
  "url": "${LIST}",
  "fetchedAt": "${fetched.toISOString().replace("Z", "123456+00:00")}",
  "retryAt": "0001-01-01T00:00:00Z",
  "body": [${JSON.stringify(listed("v2.0.0-beta.5"))}]
}
`,
    );
    const { client, seen } = network(() => "unreachable");
    const doc = await using({ box, http: client }, (u) =>
      u.check({ running: prerelease(box) }),
    );
    assert.equal(doc.version, "2.0.0-beta.5");
    assert.equal(seen.length, 0);
  });
});

describe("staging", () => {
  it("refuses outside the installed app bundle", async () => {
    const box = newBox();
    const error = await failure(
      { box, http: network(() => undefined).client },
      (u) =>
        u.stage({
          running: { ...running(box), executable: join(box.root, "sm") },
        }),
    );
    assert.equal(
      words(error),
      "This binary isn't running from the installed app bundle, so there is nothing to update.",
    );
  });

  it("downloads, verifies and parks the release", async () => {
    const box = newBox();
    const { client, seen } = network(
      serverFor("2.0.0", zipOf([{ version: "2.0.0" }])),
    );
    const { seen: steps, progress } = progressLog();
    const doc = await using({ box, http: client }, (u) =>
      u.stage({ running: running(box), progress }),
    );
    assert.deepEqual(doc, {
      ok: true,
      status: "staged",
      version: "2.0.0",
      installed: "1.0.0",
      notes: "notes for 2.0.0",
      releaseDate: "2026-09-15T12:00:00Z",
    });
    assert.deepEqual(steps, [
      { phase: "checking" },
      { phase: "downloading", version: "2.0.0" },
      { phase: "verifying", version: "2.0.0" },
    ]);
    assert.deepEqual(manifestOf(box), {
      version: "2.0.0",
      bundleName: APP,
      notes: "notes for 2.0.0",
      releaseDate: "2026-09-15T12:00:00Z",
    });
    assert.equal(versionAt(join(staged(box), APP)), "2.0.0");
    // Only the staged bundle, the manifest, and nothing of the run.
    assert.deepEqual(readdirSync(box.updates).toSorted(), ["staged"]);
    assert.deepEqual(readdirSync(staged(box)).toSorted(), [
      APP,
      "manifest.json",
    ]);
    // The three checks run at once, so in no set order.
    assert.deepEqual(
      calls().toSorted(),
      [
        `codesign --verify --deep --strict -- ${box.updates}/extract/${APP}`,
        `codesign -dvv -- ${box.installed}`,
        `codesign -dvv -- ${box.updates}/extract/${APP}`,
      ].toSorted(),
    );
    // Asked again, the staged bundle answers without a download.
    const again = await using({ box, http: client }, (u) =>
      u.stage({ running: running(box) }),
    );
    assert.equal(again.status, "staged");
    assert.equal(
      seen.filter((request) => request.url === zipUrl("2.0.0")).length,
      1,
    );
  });

  it("keeps a staged bundle on an unconfirmed answer, and clears it on a confirmed one", async () => {
    const box = newBox("2.0.0-beta.2");
    let release = "v2.0.0-beta.2";
    const { client } = network((url) =>
      url.toString() === LIST ? json([listed(release)]) : undefined,
    );
    const stage = (u: Updater.Updater["Service"]) =>
      u.stage({ running: running(box, "2.0.0-beta.2") });
    await using({ box, http: client }, (u) =>
      Effect.gen(function* () {
        // The copy of the list predates the beta.3 an earlier run staged.
        assert.equal((yield* stage(u)).status, "up-to-date");
        seedStaged(box, "2.0.0-beta.3");
        assert.equal((yield* stage(u)).version, "2.0.0-beta.3");
        assert.ok(existsSync(join(staged(box), APP)));
        // A finished install's own version isn't offered, though only a
        // confirmed answer sweeps it.
        rmSync(staged(box), { recursive: true });
        seedStaged(box, "2.0.0-beta.2");
        assert.equal((yield* stage(u)).status, "up-to-date");
        assert.ok(existsSync(join(staged(box), "manifest.json")));
        // Confirmed against the API: nothing newer, so it goes.
        release = "v2.0.0-beta.1";
        yield* TestClock.adjust("16 minutes");
        assert.equal((yield* stage(u)).status, "up-to-date");
        assert.equal(existsSync(staged(box)), false);
      }),
    );
  });

  it("keeps the staged bundle when a newer download fails", async () => {
    const box = newBox();
    seedStaged(box, "1.5.0");
    const { client } = network(serverFor("2.0.0"));
    const error = await failure({ box, http: client }, (u) =>
      u.stage({ running: running(box) }),
    );
    assert.equal(words(error), "Downloading the update failed with HTTP 404.");
    assert.deepEqual(manifestOf(box), { version: "1.5.0", bundleName: APP });
  });

  it("refuses a zip with other than one app bundle, or none at all", async () => {
    const box = newBox();
    const errorFor = (zip: Uint8Array) =>
      failure({ box, http: network(serverFor("2.0.0", zip)).client }, (u) =>
        u.stage({ running: running(box) }),
      ).then(words);
    assert.equal(
      await errorFor(
        zipOf([{ version: "2.0.0" }, { name: "Other.app", version: "2.0.0" }]),
      ),
      "The update zip contained 2 app bundles instead of exactly one.",
    );
    assert.equal(
      await errorFor(zipOf([{ name: "Shigoto no Mori", version: "2.0.0" }])),
      "The update zip contained 0 app bundles instead of exactly one.",
    );
    assert.match(
      await errorFor(new TextEncoder().encode("not a zip")),
      /^Couldn't extract the update: /,
    );
    assert.equal(existsSync(staged(box)), false);
  });

  it("refuses a bundle another team signed, or none did", async () => {
    const box = newBox();
    seedStaged(box, "1.5.0");
    const errorFor = (options: BundleOptions) =>
      failure(
        {
          box,
          http: network(
            serverFor("2.0.0", zipOf([{ version: "2.0.0", ...options }])),
          ).client,
        },
        (u) => u.stage({ running: running(box) }),
      );
    const other = await errorFor({ team: "EVIL" });
    assert.ok(other instanceof Updater.SignatureRejected);
    assert.equal(
      words(other),
      "The downloaded update is signed by a different team (EVIL, installed app: TEAM1). Refusing to install.",
    );
    assert.equal(
      words(await errorFor({ team: null })),
      "The downloaded update is signed by a different team (, installed app: TEAM1). Refusing to install.",
    );
    assert.equal(
      words(await errorFor({ unsigned: true })),
      `The downloaded update failed code-signature verification: ${box.updates}/extract/${APP}: code object is not signed at all`,
    );
    // Nothing of the refused bundle stays, and the earlier one does.
    assert.equal(existsSync(join(box.updates, "extract")), false);
    assert.deepEqual(manifestOf(box), { version: "1.5.0", bundleName: APP });
  });

  it("refuses when the installed app has no team to compare against", async () => {
    const box = newBox("1.0.0", { team: null });
    const error = await failure(
      {
        box,
        http: network(serverFor("2.0.0", zipOf([{ version: "2.0.0" }]))).client,
      },
      (u) => u.stage({ running: running(box) }),
    );
    assert.equal(
      words(error),
      "The installed app has no Team ID to verify the update against. Refusing to install.",
    );
  });

  it("fails closed with the real codesign", async () => {
    touch("real-codesign");
    const unsigned = newBox();
    const plain = await failure(
      {
        box: unsigned,
        http: network(serverFor("2.0.0", zipOf([{ version: "2.0.0" }]))).client,
      },
      (u) => u.stage({ running: running(unsigned) }),
    );
    assert.match(
      words(plain),
      /^The downloaded update failed code-signature verification: .*code object is not signed at all/,
    );
    // Ad hoc signatures verify, and carry no team, so they refuse too.
    const box = newBox();
    execFileSync("/usr/bin/codesign", ["-s", "-", "--deep", box.installed]);
    const dir = mkdtempSync(join(zips, "adhoc-"));
    makeBundle(join(dir, APP), "2.0.0");
    execFileSync("/usr/bin/codesign", ["-s", "-", "--deep", join(dir, APP)]);
    execFileSync("/usr/bin/ditto", ["-c", "-k", dir, `${dir}.zip`]);
    const adhoc = await failure(
      {
        box,
        http: network(
          serverFor("2.0.0", new Uint8Array(readFileSync(`${dir}.zip`))),
        ).client,
      },
      (u) => u.stage({ running: running(box) }),
    );
    assert.equal(
      words(adhoc),
      "The installed app has no Team ID to verify the update against. Refusing to install.",
    );
  });
});

const lockFile = (box: Box) => join(box.updates, "staging.pid");

const holdLock = (box: Box, content: string) => {
  mkdirSync(box.updates, { recursive: true });
  writeFileSync(lockFile(box), content);
};

describe("the staging lock", () => {
  it("turns a stager away while a live process holds it", async () => {
    const box = newBox();
    const holder = livePid();
    holdLock(box, `${holder}\n`);
    const { client, seen } = network(serverFor(undefined));
    const error = await failure({ box, http: client }, (u) =>
      u.stage({ running: running(box) }),
    );
    assert.deepEqual(errorDocument(error), {
      error: `Another update is already in progress (pid ${holder}).`,
      code: "update-in-progress",
    });
    assert.equal(seen.length, 0);
    assert.equal(readFileSync(lockFile(box), "utf8"), `${holder}\n`);
  });

  it.for([
    { holder: "a dead pid", content: () => `${deadPid()}\n` },
    { holder: "no pid", content: () => "garbage" },
    { holder: "pid 1", content: () => "1" },
    { holder: "nothing", content: () => "" },
  ])(
    "breaks a lock held by $holder, and lets go after",
    async ({ content }) => {
      const box = newBox();
      holdLock(box, content());
      const doc = await using(
        { box, http: network(serverFor(undefined)).client },
        (u) => u.stage({ running: running(box) }),
      );
      assert.equal(doc.status, "up-to-date");
      assert.equal(existsSync(lockFile(box)), false);
      assert.deepEqual(readdirSync(box.updates), []);
    },
  );

  it("turns a second stager away while the first one runs", async () => {
    const box = newBox();
    const serve = serverFor("2.0.0", zipOf([{ version: "2.0.0" }]));
    const asked = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    // The first stager's feed answer waits for the test.
    const { client } = network((url) =>
      url.toString().startsWith(FEED)
        ? Deferred.succeed(asked, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(serve(url)),
          )
        : serve(url),
    );
    const second = await using({ box, http: client }, (u) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(
          u.stage({ running: running(box) }),
        );
        yield* Deferred.await(asked);
        const turnedAway = yield* Effect.flip(
          u.stage({ running: running(box) }),
        );
        yield* Deferred.succeed(gate, undefined);
        assert.equal((yield* Fiber.join(first)).status, "staged");
        return turnedAway;
      }),
    );
    assert.ok(second instanceof Updater.UpdateInProgress);
    assert.deepEqual(manifestOf(box), {
      version: "2.0.0",
      bundleName: APP,
      notes: "notes for 2.0.0",
      releaseDate: "2026-09-15T12:00:00Z",
    });
  });
});

describe("leftovers", () => {
  const debris = (box: Box) => {
    const apps = dirname(box.installed);
    mkdirSync(join(box.updates, "extract", APP), { recursive: true });
    writeFileSync(join(box.updates, "download.zip"), "partial");
    makeBundle(join(apps, `${APP}.old-123`), "0.9.0");
    makeBundle(join(apps, `.${APP}.new-456`), "2.0.0");
    makeBundle(join(apps, "Other.app"), "1.0.0");
    writeFileSync(join(apps, `${APP}.old`), "not ours");
  };

  it("are swept at the start of a run", async () => {
    const box = newBox();
    debris(box);
    await using({ box, http: network(serverFor(undefined)).client }, (u) =>
      u.stage({ running: running(box) }),
    );
    assert.deepEqual(readdirSync(box.updates), []);
    assert.deepEqual(readdirSync(dirname(box.installed)).toSorted(), [
      "Other.app",
      APP,
      `${APP}.old`,
    ]);
  });

  it("keep the set-aside app while the app itself is missing", async () => {
    const box = newBox();
    debris(box);
    const executable = running(box).executable;
    // A crash between the swap's renames: the aside is the only copy. The
    // terminal binary's own path still resolves through it.
    rmSync(box.installed, { recursive: true });
    await using({ box, http: network(serverFor(undefined)).client }, (u) =>
      u.stage({ running: { ...running(box), executable } }),
    ).catch(() => undefined);
    assert.ok(existsSync(join(dirname(box.installed), `${APP}.old-123`)));
  });
});

// --- the swap ---

// A box with 2.0.0 staged and served, ready to install over 1.0.0.
const readyBox = async () => {
  const box = newBox();
  const http = network(
    serverFor("2.0.0", zipOf([{ version: "2.0.0" }])),
  ).client;
  await using({ box, http }, (u) => u.stage({ running: running(box) }));
  return { box, http };
};

const apps = (box: Box) => readdirSync(dirname(box.installed)).toSorted();

// What the swap leaves: an app at the target, old or new, and no scratch
// bundle beside it.
const intact = (box: Box) => {
  assert.ok(["1.0.0", "2.0.0"].includes(versionAt(box.installed)));
  assert.deepEqual(apps(box), [APP]);
};

const failing =
  (step: (from: string, to: string) => boolean): Fault =>
  (from, to) =>
    step(from, to)
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
            description: "EIO: injected",
            pathOrDescriptor: from,
          }),
        )
      : undefined;

const isIncoming = (to: string) => to.includes(`.${APP}.new-`);

const beforeTheSwap: ReadonlyArray<{
  readonly name: string;
  readonly prepare?: (box: Box) => void;
  readonly fault?: Fault;
  readonly words: (box: Box) => string | RegExp;
}> = [
  {
    name: "the copy",
    prepare: () => touch("ditto-fails"),
    fault: failing((_, to) => isIncoming(to)),
    words: () =>
      "Couldn't move the update next to the app: ditto: no space left",
  },
  {
    name: "the second verification",
    prepare: (box) =>
      writeFileSync(join(staged(box), APP, "Contents", "TEAM"), "EVIL"),
    words: () =>
      "The downloaded update is signed by a different team (EVIL, installed app: TEAM1). Refusing to install.",
  },
  {
    name: "setting the old app aside",
    fault: failing((from) => from.endsWith(APP) && !from.includes("staged")),
    words: () => /^Couldn't move the old app aside: /,
  },
  {
    name: "renaming the new one in",
    fault: failing((from, to) => isIncoming(from) && to.endsWith(APP)),
    words: () =>
      /^Couldn't install the update: .* \(the old app was restored\)$/,
  },
];

const interruptions: ReadonlyArray<{
  readonly name: string;
  readonly at: (box: Box, from: string, to: string) => boolean;
  readonly version: string;
}> = [
  // Before the swap: the old app stays.
  { name: "placing", at: (_, __, to) => isIncoming(to), version: "1.0.0" },
  // Inside it: the swap runs to its end.
  {
    name: "setting aside",
    at: (box, from) => from === box.installed,
    version: "2.0.0",
  },
  {
    name: "renaming in",
    at: (box, _, to) => to === box.installed,
    version: "2.0.0",
  },
];

describe("installing", () => {
  it("swaps the staged bundle in when no app runs", async () => {
    const { box, http } = await readyBox();
    const { seen, progress } = progressLog();
    const doc = await using({ box, http }, (u) =>
      u.update({ running: running(box), progress }),
    );
    assert.deepEqual(doc, {
      ok: true,
      status: "updated",
      from: "1.0.0",
      to: "2.0.0",
    });
    assert.equal(versionAt(box.installed), "2.0.0");
    intact(box);
    assert.deepEqual(readdirSync(box.updates), []);
    assert.deepEqual(seen.at(-1), { phase: "installing", version: "2.0.0" });
    // Verified again where it was placed.
    assert.ok(
      calls().includes(
        `codesign --verify --deep --strict -- ${dirname(box.installed)}/.${APP}.new-${process.pid}`,
      ),
    );
  });

  it("reads the installed app's Team ID once in a run", async () => {
    const box = newBox();
    const { client } = network(
      serverFor("2.0.0", zipOf([{ version: "2.0.0" }])),
    );
    await using({ box, http: client }, (u) =>
      u.update({ running: running(box) }),
    );
    assert.equal(versionAt(box.installed), "2.0.0");
    // Verified when staged and again when placed, against one reading.
    assert.equal(
      calls().filter((line) => line.startsWith("codesign --verify")).length,
      2,
    );
    assert.equal(
      calls().filter((line) => line === `codesign -dvv -- ${box.installed}`)
        .length,
      1,
    );
  });

  it("copies the bundle over when it can't be moved next to the app", async () => {
    const { box, http } = await readyBox();
    const doc = await using(
      { box, http, fault: failing((_, to) => isIncoming(to)) },
      (u) => u.update({ running: running(box) }),
    );
    assert.equal(doc.status, "updated");
    assert.equal(versionAt(box.installed), "2.0.0");
    intact(box);
    assert.equal(existsSync(staged(box)), false);
  });

  it.for(beforeTheSwap)(
    "leaves the old app whole when $name fails",
    async ({ prepare, fault, words: expected }) => {
      const { box, http } = await readyBox();
      prepare?.(box);
      const error = await failure({ box, http, fault }, (u) =>
        u.update({ running: running(box) }),
      );
      const want = expected(box);
      if (typeof want === "string") assert.equal(words(error), want);
      else assert.match(words(error), want);
      assert.equal(versionAt(box.installed), "1.0.0");
      intact(box);
      // The update stays staged for another try.
      assert.ok(existsSync(join(staged(box), "manifest.json")));
    },
  );

  it("says where the old app is when the rollback fails too", async () => {
    const { box, http } = await readyBox();
    const aside = `${box.installed}.old-${process.pid}`;
    const error = await failure(
      {
        box,
        http,
        fault: failing((_, to) => to === box.installed),
      },
      (u) => u.update({ running: running(box) }),
    );
    assert.ok(error instanceof Updater.SwapFailed);
    assert.match(
      words(error),
      new RegExp(
        `^Couldn't install the update \\(.*\\) and restoring the old app failed too \\(.*\\)\\. The old app is at ${aside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`,
      ),
    );
    assert.equal(existsSync(box.installed), false);
    assert.equal(versionAt(aside), "1.0.0");
    assert.deepEqual(apps(box), [`${APP}.old-${process.pid}`]);
    // The next run's sweep leaves the only copy alone.
    const executable = running(box).executable;
    await using({ box, http }, (u) =>
      u.stage({ running: { ...running(box), executable } }),
    ).catch(() => undefined);
    assert.equal(versionAt(aside), "1.0.0");
  });

  it.for(interruptions)(
    "never leaves the app missing when interrupted $name",
    async (step) => {
      const { box, http } = await readyBox();
      await Effect.runPromise(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          const fault: Fault = (from, to) =>
            step.at(box, from, to)
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                )
              : undefined;
          const fiber = yield* Effect.forkDetach(
            Effect.flatMap(Updater.Updater, (u) =>
              u.update({ running: running(box) }),
            ).pipe(Effect.provide(layerFor({ box, http, fault }))),
          );
          yield* Deferred.await(reached);
          const interrupted = yield* Effect.forkDetach(Fiber.interrupt(fiber));
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(interrupted);
        }),
      );
      assert.equal(versionAt(box.installed), step.version, step.name);
      assert.ok(existsSync(box.installed), step.name);
      // Whatever scratch a stopped run left, the next one sweeps.
      await using({ box, http: network(serverFor(undefined)).client }, (u) =>
        u.stage({ running: running(box, step.version) }),
      );
      intact(box);
    },
  );
});

const finish = (setup: Setup, appPid: number) =>
  Effect.flatMap(Updater.Updater, (u) =>
    u.finishInstall({ running: running(setup.box), appPid }),
  );

// The install log's lines, each checked for its local timestamp.
const log = (box: Box) =>
  readFileSync(join(box.updates, "install.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d) /);
      return line.replace(/^\S+ /, "");
    });

describe("finishing an install for the app", () => {
  it("waits for the app to quit, installs, and relaunches it", async () => {
    const { box, http } = await readyBox();
    const pid = deadPid();
    await using({ box, http }, (u) =>
      u.finishInstall({ running: running(box), appPid: pid }),
    );
    assert.equal(versionAt(box.installed), "2.0.0");
    assert.deepEqual(log(box), [
      `finish-install: waiting for app pid ${pid} to exit`,
      "finish-install: installed 2.0.0 and relaunched",
    ]);
    assert.equal(calls().at(-1), `open ${box.installed}`);
  });

  it("gives up on an app that won't quit", async () => {
    const { box, http } = await readyBox();
    const pid = livePid();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const fiber = yield* Effect.forkChild(
          Effect.flip(finish({ box, http }, pid)),
        );
        return yield* driven(fiber, "10 seconds");
      }).pipe(
        Effect.provide(Layer.merge(layerFor({ box, http }), TestClock.layer())),
      ),
    );
    assert.equal(words(error), `Process ${pid} is still running after 2m0s.`);
    assert.equal(versionAt(box.installed), "1.0.0");
    assert.equal(
      log(box).at(-1),
      `finish-install: Process ${pid} is still running after 2m0s. (aborting)`,
    );
    assert.equal(
      calls().some((line) => line.startsWith("open")),
      false,
    );
  });

  it("brings the current app back when the install fails", async () => {
    const box = newBox();
    const http = network(() => undefined).client;
    const error = await failure({ box, http }, (u) =>
      u.finishInstall({ running: running(box), appPid: deadPid() }),
    );
    assert.equal(words(error), "No staged update to install.");
    assert.equal(
      log(box).at(-1),
      "finish-install: No staged update to install. (relaunching the current app)",
    );
    assert.deepEqual(calls(), [`open ${box.installed}`]);
  });

  it("says so when the relaunch fails", async () => {
    const { box, http } = await readyBox();
    touch("open-fails");
    const error = await failure({ box, http }, (u) =>
      u.finishInstall({ running: running(box), appPid: deadPid() }),
    );
    assert.equal(
      words(error),
      "Installed 2.0.0 but couldn't relaunch the app: exit status 1",
    );
    assert.equal(
      log(box).at(-1),
      "finish-install: installed 2.0.0 but relaunch failed: exit status 1",
    );
    assert.equal(versionAt(box.installed), "2.0.0");
  });

  it("waits out a stager that holds the lock, then reads what is staged", async () => {
    const box = newBox();
    const http = network(() => undefined).client;
    mkdirSync(box.updates, { recursive: true });
    const lock = join(box.updates, "staging.pid");
    writeFileSync(lock, String(process.pid));
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const fiber = yield* Effect.forkChild(
          Effect.flip(finish({ box, http }, deadPid())),
        );
        yield* until(
          () =>
            existsSync(join(box.updates, "install.log")) &&
            readFileSync(join(box.updates, "install.log"), "utf8").includes(
              "waiting",
            ),
        );
        yield* TestClock.adjust("1 second");
        yield* TestClock.withLive(Effect.sleep("20 millis"));
        assert.equal(fiber.pollUnsafe(), undefined);
        rmSync(lock);
        return yield* driven(fiber, "200 millis");
      }).pipe(
        Effect.provide(Layer.merge(layerFor({ box, http }), TestClock.layer())),
      ),
    );
    assert.ok(error instanceof Updater.NothingStaged);
  });

  it("gives up on a lock that is held too long", async () => {
    const box = newBox();
    const http = network(() => undefined).client;
    mkdirSync(box.updates, { recursive: true });
    writeFileSync(join(box.updates, "staging.pid"), String(process.pid));
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const fiber = yield* Effect.forkChild(
          Effect.flip(finish({ box, http }, deadPid())),
        );
        return yield* driven(fiber, "10 seconds");
      }).pipe(
        Effect.provide(Layer.merge(layerFor({ box, http }), TestClock.layer())),
      ),
    );
    assert.ok(error instanceof Updater.UpdateInProgress);
  });
});

// What the app publishes in updater.json.
const status = (box: Box, value: unknown) => {
  mkdirSync(box.dataDir, { recursive: true });
  writeFileSync(join(box.dataDir, "updater.json"), JSON.stringify(value));
};

const request = (box: Box) => join(box.dataDir, "updater-request.json");

describe("updating under a running app", () => {
  // update() forked under the test clock, with what the test does while
  // it waits.
  const updating = async <A>(
    setup: Setup,
    meanwhile: (
      fiber: Fiber.Fiber<Updater.UpToDate | Updater.Updated, unknown>,
    ) => Effect.Effect<A, unknown>,
    progress?: (progress: Updater.Progress) => Effect.Effect<void>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(Updater.Updater, (u) =>
            u.update({ running: running(setup.box), progress }),
          ),
        );
        return yield* meanwhile(fiber);
      }).pipe(Effect.provide(Layer.merge(layerFor(setup), TestClock.layer()))),
    );

  it("asks the app to restart into the update, and waits for the new one", async () => {
    const { box, http } = await readyBox();
    const app = livePid();
    touch("app-pids", `${app}\n`);
    touch("app-running");
    status(box, {
      pid: app,
      appVersion: "1.0.0",
      state: { kind: "ready", version: "2.0.0", releaseDate: null },
    });
    const { seen, progress } = progressLog();
    const doc = await updating(
      { box, http },
      (fiber) =>
        Effect.gen(function* () {
          yield* until(() => existsSync(request(box)));
          const asked = JSON.parse(readFileSync(request(box), "utf8"));
          assert.equal(asked.action, "install");
          assert.equal(typeof asked.requestedAt, "number");
          // The relaunched app publishes its own state.
          const relaunched = livePid();
          touch("app-pids", `${app}\n${relaunched}\n`);
          status(box, {
            pid: relaunched,
            appVersion: "2.0.0",
            state: { kind: "idle" },
          });
          return yield* driven(fiber, "200 millis");
        }),
      progress,
    );
    assert.deepEqual(doc, {
      ok: true,
      status: "updated",
      from: "1.0.0",
      to: "2.0.0",
    });
    // The app swaps, not this.
    assert.equal(versionAt(box.installed), "1.0.0");
    assert.deepEqual(seen.at(-1), { phase: "restarting", version: "2.0.0" });
  });

  it("reports the app's own failure once it publishes one", async () => {
    const { box, http } = await readyBox();
    const app = livePid();
    touch("app-pids", `${app}\n`);
    status(box, { pid: app, appVersion: "1.0.0", state: { kind: "idle" } });
    const error = await updating({ box, http }, (fiber) =>
      Effect.gen(function* () {
        yield* until(() => existsSync(request(box)));
        status(box, {
          pid: app,
          appVersion: "1.0.0",
          state: { kind: "error", message: "disk full" },
        });
        return yield* driven(fiber, "200 millis").pipe(Effect.flip);
      }),
    );
    assert.equal(words(error), "Install failed: disk full");
  });

  it("pays no mind to an error from before the request, and times out tentatively", async () => {
    const { box, http } = await readyBox();
    const app = livePid();
    touch("app-pids", `${app}\n`);
    status(box, {
      pid: app,
      appVersion: "1.0.0",
      state: { kind: "error", message: "old" },
    });
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(box.dataDir, "updater.json"), past, past);
    const { seen, progress } = progressLog();
    const error = await updating(
      { box, http },
      (fiber) => driven(fiber, "5 seconds").pipe(Effect.flip),
      progress,
    );
    assert.equal(
      words(error),
      "The app hasn't restarted yet. It may still be waiting on a confirmation in the app (confirming there will still install the update), or the install failed. Check the app.",
    );
    assert.ok(seen.some((step) => step.phase === "waiting-for-restart"));
  });

  it("calls a restart into the same version a likely failure", async () => {
    const { box, http } = await readyBox();
    const app = livePid();
    touch("app-pids", `${app}\n`);
    status(box, { pid: app, appVersion: "1.0.0", state: { kind: "idle" } });
    const error = await updating({ box, http }, (fiber) =>
      Effect.gen(function* () {
        yield* until(() => existsSync(request(box)));
        const relaunched = livePid();
        touch("app-pids", `${app}\n${relaunched}\n`);
        status(box, {
          pid: relaunched,
          appVersion: "1.0.0",
          state: { kind: "idle" },
        });
        return yield* driven(fiber, "5 seconds").pipe(Effect.flip);
      }),
    );
    assert.equal(
      words(error),
      `The app restarted but is still on 1.0.0, so the install may have failed. Check ${box.updates}/install.log.`,
    );
  });

  it("won't swap under an app that hasn't published its state", async () => {
    const { box, http } = await readyBox();
    touch("app-running");
    // updater.json names a pid from an earlier run.
    status(box, {
      pid: deadPid(),
      appVersion: "0.9.0",
      state: { kind: "idle" },
    });
    const { seen, progress } = progressLog();
    const error = await updating(
      { box, http },
      (fiber) => driven(fiber, "1 second").pipe(Effect.flip),
      progress,
    );
    assert.equal(
      words(error),
      "The app is running but hasn't published its updater state. Wait for it to finish starting (or quit it) and rerun `sm update`.",
    );
    assert.equal(versionAt(box.installed), "1.0.0");
    assert.deepEqual(seen.at(-1), { phase: "waiting-for-app" });
  });

  it("goes on once the starting app publishes", async () => {
    const { box, http } = await readyBox();
    touch("app-running");
    const doc = await updating({ box, http }, (fiber) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 seconds");
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        const app = livePid();
        touch("app-pids", `${app}\n`);
        status(box, { pid: app, appVersion: "1.0.0", state: { kind: "idle" } });
        yield* until(() => existsSync(request(box)), "200 millis");
        const relaunched = livePid();
        touch("app-pids", `${app}\n${relaunched}\n`);
        status(box, {
          pid: relaunched,
          appVersion: "2.0.0",
          state: { kind: "idle" },
        });
        return yield* driven(fiber, "200 millis");
      }),
    );
    assert.deepEqual(doc, {
      ok: true,
      status: "updated",
      from: "1.0.0",
      to: "2.0.0",
    });
  });
});
