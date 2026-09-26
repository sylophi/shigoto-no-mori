// The villager data this device holds: each doubutsu villager's face
// and profile, downloaded from Nookipedia only when the user asks
// (Settings, under Village life), kept on disk and served from there
// from then on, offline included. This module owns all of it: the
// status, the download (with progress, cancel and resume), removal, and
// reading a face or the profiles back.
//
// It lives in the data dir, <data dir>/villagers, because that is where
// the host keeps what it fetched for itself (the staged app update in
// updates/, the project icon cache in iconCache/). Electron's userData
// belongs to the window's own client state and is out of reach of
// host/, which never imports Electron. Being there also means a peer's
// Settings manages that device's copy, SHIGOMORI_DATA_DIR sandboxes it,
// moving the data dir carries it along, and nuke clears it.
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
import { z } from "zod";
import { errorMessageOf } from "@shared/errors";
import {
  type VillagerDataStatus,
  type VillagerProfiles,
  VillagerProfilesSchema,
} from "@shared/schemas";
import { createLimiter } from "@shared/util/limit";
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
import {
  atomicWriteJson,
  readJsonOrNull,
  tempPathFor,
  unlinkIfExists,
} from "./util/jsonFile";
import { dataDir, isENOENT } from "./util/paths";

// Villagers per API request (the API's cap on titles), and faces in
// flight at once.
const BATCH = 50;
const CONCURRENCY = 4;
// A request that has not answered by then is given up on.
const REQUEST_TIMEOUT_MS = 30_000;

const MetaSchema = z.object({
  downloadedAt: z.string(),
  manifest: z.string(),
  villagers: z.number(),
});
type Meta = z.infer<typeof MetaSchema>;

export interface VillagerData {
  status(): Promise<VillagerDataStatus>;
  // Starts a download, unless one is running or the data is already
  // here, and answers with the status that leaves: downloading, or
  // ready.
  start(): Promise<VillagerDataStatus>;
  // Resolves once the download under way, if any, has ended.
  settled(): Promise<void>;
  // Stops the download under way and drops what it stored.
  cancel(): Promise<VillagerDataStatus>;
  // Deletes the villager data, stopping a download first.
  remove(): Promise<VillagerDataStatus>;
  // A villager's face as base64 PNG, or null without one.
  face(slug: string): Promise<string | null>;
  // Every villager's profile, or null until the download has finished.
  profiles(): Promise<VillagerProfiles | null>;
}

// What a folder holds so far: its profiles and the slugs with a face.
interface Stored {
  profiles: VillagerProfiles;
  faces: Set<string>;
}

// A stop worth telling the user about in these words.
class VillagerDataError extends Error {}

// The download under way: its progress, and how it ends.
interface Run {
  done: number;
  abort: AbortController;
  cancelled: boolean;
  finished: Promise<void>;
}

export function createVillagerData({
  dir,
  manifest = villagerManifest,
  fetch = globalThis.fetch,
}: {
  // The folder the data lives in, asked for on each use.
  dir: () => string;
  manifest?: VillagerManifest;
  fetch?: typeof globalThis.fetch;
}): VillagerData {
  const slugs = Object.keys(manifest.villagers);
  const total = slugs.length;
  const readyDir = () => join(dir(), "ready");
  const partialDir = () => join(dir(), "partial");

  let run: Run | null = null;
  // Start, cancel and remove one at a time, so a remove from one
  // client can't delete the folder a start from another just made.
  const serial = createLimiter(1);
  // Why the last download stopped, until the next one starts. A
  // partial/ left by a download this process never ran (the app closed
  // mid-way) has no reason on record.
  let lastFailure: string | null = null;

  async function status(): Promise<VillagerDataStatus> {
    if (run !== null) {
      return { kind: "downloading", done: run.done, villagers: total };
    }
    const meta = await readIfValid(join(readyDir(), "meta.json"), MetaSchema);
    if (meta !== null) {
      return {
        kind: "ready",
        downloadedAt: meta.downloadedAt,
        villagers: meta.villagers,
      };
    }
    const stored = await readStored(partialDir());
    if (stored !== null) {
      return {
        kind: "failed",
        done: countDone(stored),
        villagers: total,
        message: lastFailure ?? "The download was interrupted.",
      };
    }
    return { kind: "absent", villagers: total };
  }

  function countDone(stored: Stored): number {
    return slugs.filter(
      (slug) => Object.hasOwn(stored.profiles, slug) && stored.faces.has(slug),
    ).length;
  }

  // A request to the wiki or its image host, read with `read`, which
  // fails in the words the Settings line shows (the body too: it can
  // stall or come back as something else).
  async function get<T>(
    url: string,
    signal: AbortSignal,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": WIKI_USER_AGENT },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) {
        throw new VillagerDataError(
          `Nookipedia answered with an error (${response.status}).`,
        );
      }
      return await read(response);
    } catch (error) {
      if (signal.aborted || error instanceof VillagerDataError) throw error;
      if ((error as Error).name === "TimeoutError") {
        throw new VillagerDataError("Nookipedia took too long to answer.");
      }
      if (error instanceof SyntaxError) {
        throw new VillagerDataError("Nookipedia answered unexpectedly.");
      }
      throw new VillagerDataError("Couldn't reach Nookipedia.");
    }
  }

  // The profiles of `batch`, from one request for their pages (more
  // only if the API splits its answer).
  async function fetchProfiles(
    batch: readonly string[],
    signal: AbortSignal,
  ): Promise<VillagerProfiles> {
    const titles = [
      ...new Set(batch.map((slug) => manifest.villagers[slug].page)),
    ];
    const pages = new Map<string, { wikitext: string; categories: string[] }>();
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
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, to go easy on the wiki
      const data = await get(`${WIKI_API}?${params}`, signal, (r) => r.json());
      // The API reports its own errors (lag, rate limits) with a 200.
      if (data.error !== undefined) {
        throw new VillagerDataError(
          `Nookipedia answered with an error (${data.error.code}).`,
        );
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
          throw new VillagerDataError(`Nookipedia has no page ${title}.`);
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
    const profiles: VillagerProfiles = {};
    for (const slug of batch) {
      const title = manifest.villagers[slug].page;
      profiles[slug] = villagerProfile(slug, { title, ...pageOf(title) });
    }
    return profiles;
  }

  // Downloads a face into `folder`, once it matches the manifest.
  async function fetchFace(
    slug: string,
    folder: string,
    signal: AbortSignal,
    name: string,
  ): Promise<void> {
    const { image, bytes, sha1 } = manifest.villagers[slug].icon;
    const body = Buffer.from(await get(image, signal, (r) => r.arrayBuffer()));
    if (body.length !== bytes || sha1Of(body) !== sha1) {
      throw new VillagerDataError(
        `${name}'s face didn't match what Nookipedia lists.`,
      );
    }
    const path = join(folder, "faces", `${slug}.png`);
    const temp = tempPathFor(path);
    await writeFile(temp, body);
    try {
      await rename(temp, path);
    } catch (error) {
      await unlinkIfExists(temp);
      throw error;
    }
  }

  async function fill(current: Run): Promise<void> {
    const folder = partialDir();
    const { signal } = current.abort;
    await mkdir(join(folder, "faces"), { recursive: true });
    const stored: Stored = (await readStored(folder)) ?? {
      profiles: {},
      faces: new Set(),
    };
    // Resuming: a face is kept only while it still matches the
    // manifest, which an app update in between may have moved.
    await Promise.all(
      [...stored.faces].map(async (slug) => {
        const path = join(folder, "faces", `${slug}.png`);
        const held =
          Object.hasOwn(manifest.villagers, slug) &&
          sha1Of(await readFile(path)) === manifest.villagers[slug].icon.sha1;
        if (!held) {
          stored.faces.delete(slug);
          await rm(path, { force: true });
        }
      }),
    );
    const { profiles, faces } = stored;
    const tally = () => {
      current.done = countDone(stored);
    };
    tally();

    for (let i = 0; i < slugs.length; i += BATCH) {
      const batch = slugs.slice(i, i + BATCH);
      const unknown = batch.filter((slug) => !Object.hasOwn(profiles, slug));
      if (unknown.length > 0) {
        // oxlint-disable-next-line no-await-in-loop -- a batch at a time, in order
        Object.assign(profiles, await fetchProfiles(unknown, signal));
        // oxlint-disable-next-line no-await-in-loop -- saved before its faces start
        await atomicWriteJson(join(folder, "profiles.json"), profiles, {
          selfWrite: false,
        });
        tally();
      }
      // oxlint-disable-next-line no-await-in-loop -- a batch at a time, in order
      await eachLimited(
        batch.filter((slug) => !faces.has(slug)),
        current.abort,
        async (slug) => {
          await fetchFace(slug, folder, signal, profiles[slug]?.name ?? slug);
          faces.add(slug);
          tally();
        },
      );
    }

    const meta: Meta = {
      downloadedAt: new Date().toISOString(),
      manifest: manifest.source.retrieved,
      villagers: total,
    };
    await atomicWriteJson(join(folder, "meta.json"), meta, {
      selfWrite: false,
    });
    await rm(readyDir(), { recursive: true, force: true });
    await rename(folder, readyDir());
  }

  function begin(): Run {
    const current: Run = {
      done: 0,
      abort: new AbortController(),
      cancelled: false,
      finished: Promise.resolve(),
    };
    lastFailure = null;
    current.finished = fill(current)
      .catch(async (error: unknown) => {
        if (current.cancelled) {
          await rm(partialDir(), { recursive: true, force: true });
          return;
        }
        lastFailure =
          error instanceof VillagerDataError
            ? error.message
            : `Couldn't save the villager data: ${errorMessageOf(error)}`;
      })
      .finally(() => {
        run = null;
      });
    return current;
  }

  async function stop(): Promise<void> {
    if (run === null) return;
    run.cancelled = true;
    run.abort.abort();
    await run.finished;
  }

  return {
    status,
    start: () =>
      serial(async () => {
        if (run === null) {
          const current = await status();
          if (current.kind === "ready") return current;
          run = begin();
        }
        return status();
      }),
    async settled() {
      await run?.finished;
    },
    cancel: () =>
      serial(async () => {
        await stop();
        return status();
      }),
    remove: () =>
      serial(async () => {
        await stop();
        await rm(dir(), { recursive: true, force: true });
        lastFailure = null;
        return status();
      }),
    async face(slug) {
      if (!Object.hasOwn(manifest.villagers, slug)) return null;
      try {
        const bytes = await readFile(join(readyDir(), "faces", `${slug}.png`));
        return bytes.toString("base64");
      } catch (error) {
        if (isENOENT(error)) return null;
        throw error;
      }
    },
    profiles: () =>
      readJsonOrNull(join(readyDir(), "profiles.json"), VillagerProfilesSchema),
  };
}

// Runs `task` over `items`, CONCURRENCY at a time. The first failure
// stops the rest (through `abort`, which the tasks' requests listen
// to), and once every task has settled it is the one thrown.
async function eachLimited<T>(
  items: readonly T[],
  abort: AbortController,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const limit = createLimiter(CONCURRENCY);
  let failure: { error: unknown } | undefined;
  await Promise.allSettled(
    items.map((item) =>
      limit(async () => {
        abort.signal.throwIfAborted();
        try {
          await task(item);
        } catch (error) {
          failure ??= { error };
          abort.abort();
        }
      }),
    ),
  );
  if (failure !== undefined) throw failure.error;
  abort.signal.throwIfAborted();
}

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
function readIfValid<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  return readJsonOrNull(path, schema).catch(() => null);
}

function sha1Of(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

// This device's villager data, in its data dir.
let deviceVillagerData: VillagerData | undefined;
export function villagerData(): VillagerData {
  deviceVillagerData ??= createVillagerData({
    dir: () => join(dataDir(), "villagers"),
  });
  return deviceVillagerData;
}
