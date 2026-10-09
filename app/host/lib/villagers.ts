// The villager data this device holds: each doubutsu villager's face
// and profile, downloaded from Nookipedia only when the user asks
// (Settings, Appearance, beside Village life), kept on disk and served
// to this device's own window from then on, offline included. This
// module owns all of it: the status, the download (with progress,
// cancel and resume), removal, and reading a face or the profiles back.
//
// It lives in the data dir, <data dir>/villagers, because that is where
// the host keeps what it fetched for itself (the staged app update in
// updates/, the project icon cache in iconCache/). Electron's userData
// belongs to the window's own client state and is out of reach of
// host/, which never imports Electron. Being there also means
// SHIGOMORI_DATA_DIR sandboxes it, moving the data dir carries it along,
// and nuke clears it.
//
// Layout:
//   ready/              a finished download, which only appears whole
//     meta.json         when, from which manifest, how many
//     profiles.json     slug → profile
//     faces/<slug>.png
//   partial/            a download under way or stopped: the same,
//                       minus meta.json
// A download fills partial/: the profiles rewritten whole after each
// batch, each face written under a temp name and renamed in once its
// size and sha1 match the manifest. Last it writes meta.json and
// renames partial/ to ready/, so a half-finished download never looks
// finished, and a stopped one resumes from what partial/ holds.
//
// Politeness: the profiles come from the wiki's API in batches of 50
// pages, about ten requests in all, and the faces from its image host
// four at a time, all under the scripts' User-Agent. Nothing retries on
// its own: a failure stops the download, and trying again resumes it.
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { type ContractSchema, type Decoded } from "@shigomori/contracts/codec";
import {
  type VillagerDataStatus,
  type VillagerProfile,
  type VillagerProfiles,
  VillagerProfilesSchema,
} from "@shigomori/contracts/schemas";
import {
  type VillagerManifest,
  villagerManifest,
} from "@shared/villagers/manifest";
import {
  CHARACTER_CATEGORIES,
  villagerProfile,
  WIKI_API,
  WIKI_USER_AGENT,
} from "@shared/villagers/wiki";
import * as PromiseAdapter from "./util/promiseAdapter";
import {
  atomicWriteJson,
  readJsonOrNull,
  tempPathFor,
  unlinkIfExists,
} from "./util/atomicJson";
import { dataDir, isENOENT } from "./util/paths";

// Villagers per API request (the API's cap on titles), and faces in
// flight at once.
const BATCH = 50;
const CONCURRENCY = 4;
// A request that has not answered by then is given up on.
const REQUEST_TIMEOUT_MS = 30_000;

// One character as the manifest lists them, with their slug.
type ManifestEntry = [slug: string, VillagerManifest["villagers"][string]];

const MetaSchema = Schema.Struct({
  downloadedAt: Schema.String,
  manifest: Schema.String,
  villagers: Schema.Finite,
});
type Meta = typeof MetaSchema.Type;

// What stopped a download, in the words the Settings line shows.
// `subject` is the status or API error code Nookipedia answered with,
// the page it doesn't have, or the villager whose face didn't match.
class VillagerDataError extends Schema.TaggedError<VillagerDataError>()(
  "VillagerDataError",
  {
    reason: Schema.Literals([
      "unreachable",
      "timeout",
      "unexpected",
      "refused",
      "no-page",
      "face-mismatch",
    ]),
    subject: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unreachable":
        return "Couldn't reach Nookipedia.";
      case "timeout":
        return "Nookipedia took too long to answer.";
      case "unexpected":
        return "Nookipedia answered unexpectedly.";
      case "refused":
        return `Nookipedia answered with an error (${this.subject}).`;
      case "no-page":
        return `Nookipedia has no page ${this.subject}.`;
      case "face-mismatch":
        return `${this.subject}'s face didn't match what Nookipedia lists.`;
    }
  }
}

export class VillagerData extends Context.Service<
  VillagerData,
  {
    readonly status: Effect.Effect<VillagerDataStatus>;
    // Starts a download, unless one is running or the data is already
    // here, and answers with the status that leaves: downloading, or
    // ready.
    readonly start: Effect.Effect<VillagerDataStatus>;
    // Succeeds once the download under way, if any, has ended.
    readonly settled: Effect.Effect<void>;
    // Stops the download under way and drops what it stored.
    readonly cancel: Effect.Effect<VillagerDataStatus>;
    // Deletes the villager data, stopping a download first.
    readonly remove: Effect.Effect<VillagerDataStatus>;
    // A villager's face as base64 PNG, or null without one.
    readonly face: (slug: string) => Effect.Effect<string | null>;
    // Every villager's profile, or null until the download has finished.
    readonly profiles: Effect.Effect<VillagerProfiles | null>;
  }
>()("sm/host/VillagerData") {}

interface Options {
  // The folder the data lives in, asked for on each use.
  readonly dir: () => string;
  readonly manifest?: VillagerManifest;
  readonly fetch?: typeof globalThis.fetch;
}

// What a folder holds so far: its profiles and the slugs with a face.
interface Stored {
  profiles: VillagerProfiles;
  faces: Set<string>;
}

// Disk work runs to its end even when the download is stopped, so a
// stop never leaves a file half written or races the folder's removal.
// Its failures are defects: the download reports them as a failed save.
const disk = <A>(work: () => Promise<A>) =>
  Effect.uninterruptible(Effect.promise(work));

const make = ({
  dir,
  manifest = villagerManifest,
  fetch = globalThis.fetch,
}: Options) =>
  Effect.gen(function* () {
    const entries: ManifestEntry[] = Object.entries(manifest.villagers);
    const slugs = entries.map(([slug]) => slug);
    const total = entries.length;
    const readyDir = () => join(dir(), "ready");
    const partialDir = () => join(dir(), "partial");

    // The download under way. Closing the layer stops it and leaves
    // partial/ for the next launch to resume.
    const download = yield* FiberHandle.make<void, never>();
    // Villagers stored by the download under way.
    const done = yield* Ref.make(0);
    // Start, cancel and remove one at a time, so a remove from one
    // client can't delete the folder a start from another just made.
    const serial = yield* Semaphore.make(1);
    // Why the last download stopped, until the next one starts. A
    // partial/ left by a download this process never ran (the app closed
    // mid-way) has no reason on record.
    const lastFailure = yield* Ref.make<string | null>(null);

    const countDone = (stored: Stored) =>
      slugs.filter(
        (slug) =>
          Object.hasOwn(stored.profiles, slug) && stored.faces.has(slug),
      ).length;

    const status = Effect.gen(function* () {
      if (Option.isSome(yield* FiberHandle.get(download))) {
        return {
          kind: "downloading",
          done: yield* Ref.get(done),
          villagers: total,
        } satisfies VillagerDataStatus;
      }
      const meta = yield* disk(() =>
        readIfValid(join(readyDir(), "meta.json"), MetaSchema),
      );
      if (meta !== null) {
        return {
          kind: "ready",
          downloadedAt: meta.downloadedAt,
          villagers: meta.villagers,
        } satisfies VillagerDataStatus;
      }
      const stored = yield* disk(() => readStored(partialDir()));
      if (stored !== null) {
        return {
          kind: "failed",
          done: countDone(stored),
          villagers: total,
          message:
            (yield* Ref.get(lastFailure)) ?? "The download was interrupted.",
        } satisfies VillagerDataStatus;
      }
      return { kind: "absent", villagers: total } satisfies VillagerDataStatus;
    }).pipe(Effect.withSpan("VillagerData.status"));

    // A request to the wiki or its image host, read with `read`, which
    // fails in the words the Settings line shows (the body too: it can
    // stall or come back as something else).
    const get = <T>(url: string, read: (response: Response) => Promise<T>) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            headers: { "User-Agent": WIKI_USER_AGENT },
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ]),
          });
          if (!response.ok) {
            throw new VillagerDataError({
              reason: "refused",
              subject: String(response.status),
            });
          }
          return await read(response);
        },
        catch: (error) => {
          if (error instanceof VillagerDataError) return error;
          if ((error as Error).name === "TimeoutError") {
            return new VillagerDataError({ reason: "timeout", cause: error });
          }
          if (error instanceof SyntaxError) {
            return new VillagerDataError({
              reason: "unexpected",
              cause: error,
            });
          }
          return new VillagerDataError({ reason: "unreachable", cause: error });
        },
      });

    // The profiles of `batch`, from one request for their pages (more
    // only if the API splits its answer).
    const fetchProfiles = Effect.fnUntraced(function* (
      batch: readonly ManifestEntry[],
    ) {
      const titles = [...new Set(batch.map(([, entry]) => entry.page))];
      const pages = new Map<
        string,
        { wikitext: string; categories: string[] }
      >();
      const pageOf = (title: string) =>
        pages.get(title) ?? { wikitext: "", categories: [] };
      // The asked title of each page the API answered under another name.
      const asked = new Map<string, string>();
      let cont: Record<string, string> = {};
      for (;;) {
        const params = new URLSearchParams({
          action: "query",
          format: "json",
          formatversion: "2",
          prop: "revisions|categories",
          rvprop: "content",
          rvslots: "main",
          // The lead section, which holds the infobox.
          rvsection: "0",
          clcategories: CHARACTER_CATEGORIES.join("|"),
          cllimit: "max",
          redirects: "1",
          titles: titles.join("|"),
          ...cont,
        });
        // One request at a time, to go easy on the wiki.
        const data = yield* get(`${WIKI_API}?${params}`, (r) => r.json());
        // The API reports its own errors (lag, rate limits) with a 200.
        if (data.error !== undefined) {
          return yield* new VillagerDataError({
            reason: "refused",
            subject: String(data.error.code),
          });
        }
        for (const { from, to } of [
          ...(data.query?.normalized ?? []),
          ...(data.query?.redirects ?? []),
        ]) {
          asked.set(to, asked.get(from) ?? from);
        }
        for (const page of data.query?.pages ?? []) {
          const title = asked.get(page.title) ?? page.title;
          // A page moved since the manifest was made: stop rather than
          // store an empty profile no resume would fetch again.
          if (page.missing === true) {
            return yield* new VillagerDataError({
              reason: "no-page",
              subject: title,
            });
          }
          const entry = pageOf(title);
          entry.wikitext ||= page.revisions?.[0]?.slots?.main?.content ?? "";
          for (const category of page.categories ?? []) {
            entry.categories.push(category.title);
          }
          pages.set(title, entry);
        }
        if (data.continue === undefined) break;
        cont = data.continue;
      }
      const profiles: Record<string, VillagerProfile> = {};
      for (const [slug, { page: title }] of batch) {
        profiles[slug] = villagerProfile(slug, { title, ...pageOf(title) });
      }
      return profiles;
    });

    // Downloads a face into `folder`, once it matches the manifest.
    const fetchFace = Effect.fnUntraced(function* (
      [slug, { icon }]: ManifestEntry,
      folder: string,
      name: string,
    ) {
      const { image, bytes, sha1 } = icon;
      const body = Buffer.from(yield* get(image, (r) => r.arrayBuffer()));
      if (body.length !== bytes || sha1Of(body) !== sha1) {
        return yield* new VillagerDataError({
          reason: "face-mismatch",
          subject: name,
        });
      }
      const path = join(folder, "faces", `${slug}.png`);
      yield* disk(async () => {
        const temp = tempPathFor(path);
        await writeFile(temp, body);
        try {
          await rename(temp, path);
        } catch (error) {
          await unlinkIfExists(temp);
          throw error;
        }
      });
    });

    const fill = Effect.fnUntraced(function* () {
      const folder = partialDir();
      const stored = yield* disk(async () => {
        await mkdir(join(folder, "faces"), { recursive: true });
        const found: Stored = (await readStored(folder)) ?? {
          profiles: {},
          faces: new Set(),
        };
        // Resuming: a face is kept only while it still matches the
        // manifest, which an app update in between may have moved.
        await Promise.all(
          [...found.faces].map(async (slug) => {
            const path = join(folder, "faces", `${slug}.png`);
            // hasOwn, not a lookup: the slugs here are file names.
            const entry = Object.hasOwn(manifest.villagers, slug)
              ? manifest.villagers[slug]
              : undefined;
            const held =
              entry !== undefined &&
              sha1Of(await readFile(path)) === entry.icon.sha1;
            if (!held) {
              found.faces.delete(slug);
              await rm(path, { force: true });
            }
          }),
        );
        return found;
      });
      const { profiles, faces } = stored;
      const tally = Effect.suspend(() => Ref.set(done, countDone(stored)));
      yield* tally;

      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        const unknown = batch.filter(
          ([slug]) => !Object.hasOwn(profiles, slug),
        );
        if (unknown.length > 0) {
          Object.assign(profiles, yield* fetchProfiles(unknown));
          // Saved before its faces start.
          yield* disk(() =>
            atomicWriteJson(join(folder, "profiles.json"), profiles),
          );
          yield* tally;
        }
        // The first failure stops the rest.
        yield* Effect.forEach(
          batch.filter(([slug]) => !faces.has(slug)),
          (entry) =>
            fetchFace(entry, folder, profiles[entry[0]]?.name ?? entry[0]).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  faces.add(entry[0]);
                  return tally;
                }),
              ),
            ),
          { concurrency: CONCURRENCY, discard: true },
        );
      }

      const meta: Meta = {
        downloadedAt: new Date().toISOString(),
        manifest: manifest.source.retrieved,
        villagers: total,
      };
      yield* disk(async () => {
        await atomicWriteJson(join(folder, "meta.json"), meta);
        await rm(readyDir(), { recursive: true, force: true });
        await rename(folder, readyDir());
      });
    });

    // Stops the download under way, dropping what it stored.
    const stop = Effect.gen(function* () {
      if (Option.isNone(yield* FiberHandle.get(download))) return;
      yield* FiberHandle.clear(download);
      yield* disk(() => rm(partialDir(), { recursive: true, force: true }));
    });

    const start = Effect.gen(function* () {
      if (Option.isNone(yield* FiberHandle.get(download))) {
        const current = yield* status;
        if (current.kind === "ready") return current;
        yield* Ref.set(lastFailure, null);
        yield* Ref.set(done, 0);
        yield* FiberHandle.run(
          download,
          fill().pipe(
            Effect.catch((error) => Ref.set(lastFailure, error.message)),
            Effect.catchDefect((defect) =>
              Ref.set(
                lastFailure,
                `Couldn't save the villager data: ${errorMessageOf(defect)}`,
              ),
            ),
          ),
        );
      }
      return yield* status;
    }).pipe(serial.withPermits(1), Effect.withSpan("VillagerData.start"));

    const cancel = Effect.gen(function* () {
      yield* stop;
      return yield* status;
    }).pipe(serial.withPermits(1), Effect.withSpan("VillagerData.cancel"));

    const remove = Effect.gen(function* () {
      yield* stop;
      yield* disk(() => rm(dir(), { recursive: true, force: true }));
      yield* Ref.set(lastFailure, null);
      return yield* status;
    }).pipe(serial.withPermits(1), Effect.withSpan("VillagerData.remove"));

    const face = Effect.fn("VillagerData.face")(function* (slug: string) {
      if (!Object.hasOwn(manifest.villagers, slug)) return null;
      return yield* disk(async () => {
        try {
          const bytes = await readFile(
            join(readyDir(), "faces", `${slug}.png`),
          );
          return bytes.toString("base64");
        } catch (error) {
          if (isENOENT(error)) return null;
          throw error;
        }
      });
    });

    return VillagerData.of({
      status,
      start,
      settled: FiberHandle.awaitEmpty(download).pipe(
        Effect.withSpan("VillagerData.settled"),
      ),
      cancel,
      remove,
      face,
      profiles: disk(() =>
        readJsonOrNull(
          join(readyDir(), "profiles.json"),
          VillagerProfilesSchema,
        ),
      ).pipe(Effect.withSpan("VillagerData.profiles")),
    });
  });

export const layer = (options: Options) =>
  Layer.effect(VillagerData, make(options));

// This device's villager data, in its data dir.
export const deviceLayer = layer({
  dir: () => join(dataDir(), "villagers"),
});

// For the IPC handlers (ipc/modules/villagers.ts), which are not Effect
// yet.
export const { layer: adapter, call } = PromiseAdapter.forService(
  VillagerData,
  "The villager data",
);

// What a folder holds so far, or null when there is no such folder.
async function readStored(folder: string): Promise<Stored | null> {
  let files: string[];
  try {
    files = await readdir(join(folder, "faces"));
  } catch (error) {
    if (isENOENT(error)) return null;
    throw error;
  }
  const profiles =
    (await readIfValid(
      join(folder, "profiles.json"),
      VillagerProfilesSchema,
    )) ?? {};
  const faces = new Set(
    files
      .filter((file) => file.endsWith(".png"))
      .map((file) => file.slice(0, -".png".length)),
  );
  return { profiles, faces };
}

// A file of ours, or null when it's missing or damaged (cut short, or
// written by a build with another shape): either way it is fetched
// again rather than left to block the data behind it.
function readIfValid<S extends ContractSchema>(
  path: string,
  schema: S,
): Promise<Decoded<S> | null> {
  return readJsonOrNull(path, schema).catch(() => null);
}

function sha1Of(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}
