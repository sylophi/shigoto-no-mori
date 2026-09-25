// Durable proof for the villager data download (host/lib/villagers.ts)
// and the Settings control's words for it
// (renderer/components/settings/villagerDataView.ts). The download runs
// against a fake wiki injected as `fetch`: no real network.
//
// Asserts:
// - a download stores every villager's profile and face, counting a
//   villager once both are stored, and appears whole (no ready/ and no
//   reads until the end)
// - a second run is a no-op
// - a face whose size or sha1 doesn't match the manifest is refused and
//   the download stops, keeping what it stored
// - trying again resumes without asking the wiki for what it already
//   has, and so does a fresh process finding a download the app never
//   finished
// - cancel stops and drops what it stored
// - a network, HTTP or wiki API failure reads in the product's words
// - damaged data reads as not there and downloads again
// - remove clears it all, mid-download too
// - the wiki is asked in batches of 50 pages with four faces at a time,
//   every request under the scripts' User-Agent
// - the Village life row opens only with names on and the data
//   downloaded
// - the Settings line for every state
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test villager-data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVillagerData } from "@host/lib/villagers";
import {
  villagerProfile,
  WIKI_API,
  WIKI_USER_AGENT,
} from "@shared/villagers/wiki";
import {
  villageLifeRow,
  villagerDataView,
} from "@/components/settings/villagerDataView";
import { makeProof, waitFor } from "./lib/checkKit.mjs";

const proof = makeProof("villager-data proof");
console.log("villager-data proof\n");

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-villagers-")));
let dirCount = 0;
const freshDir = () => join(sandbox, `data-${++dirCount}`);

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

// A villager page and face for each name, the way the wiki has them.
function character(name, { page = name, kind = "villager", size = 300 } = {}) {
  const slug = name.toLowerCase();
  const face = Buffer.alloc(size, slug);
  return {
    slug,
    page,
    face,
    categories: [
      kind === "villager"
        ? "Category:Villagers"
        : "Category:Special characters",
    ],
    wikitext: `{{Infobox Villager\n| name = ${name}\n| species = Cat\n| birthdaymonth = March\n| birthday = 4\n| phrase = ${slug}ster\n}}`,
  };
}

const TOWN = [
  character("Ace"),
  character("Bob"),
  character("Carmen"),
  character("Isabelle", { kind: "special" }),
  character("Timmy", { page: "Timmy and Tommy", kind: "special" }),
  character("Tommy", { page: "Timmy and Tommy", kind: "special" }),
  character("Zucker", { size: 900 }),
];

function manifestFor(characters) {
  return {
    source: {
      name: "Nookipedia",
      url: "https://nookipedia.com/",
      retrieved: "2026-09-25",
    },
    villagers: Object.fromEntries(
      characters.map((c) => [
        c.slug,
        {
          page: c.page,
          icon: {
            file: `File:${c.page} NH Villager Icon.png`,
            filePage: `https://nookipedia.com/wiki/File:${c.slug}.png`,
            image: `https://images.test/${c.slug}.png`,
            bytes: c.face.length,
            sha1: sha1(c.face),
          },
        },
      ]),
    ),
    missing: [],
  };
}

// The fake wiki: answers the API from the characters' pages and the
// image host from their faces, and records every request. `hold`
// parks face requests until released, `broken` makes one face's
// request fail in a chosen way, and `apiBroken` the API's answers.
function fakeWiki(characters) {
  const byPage = Map.groupBy(characters, (c) => c.page);
  const bySlug = new Map(characters.map((c) => [c.slug, c]));
  const wiki = {
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
    held: [],
    hold: false,
    broken: new Map(),
    apiBroken: undefined,
    apiRequests: () => wiki.requests.filter((r) => r.url.startsWith(WIKI_API)),
    faceRequests: () =>
      wiki.requests.filter((r) => r.url.startsWith("https://images.test/")),
    release(count = Number.POSITIVE_INFINITY) {
      for (const resolve of wiki.held.splice(0, count)) resolve();
    },
    releaseAll() {
      wiki.hold = false;
      wiki.release();
    },
    async fetch(input, init = {}) {
      const url = String(input);
      wiki.requests.push({ url, userAgent: init.headers?.["User-Agent"] });
      init.signal?.throwIfAborted();
      if (url.startsWith(WIKI_API)) {
        const params = new URL(url).searchParams;
        const titles = params.get("titles").split("|");
        switch (wiki.apiBroken) {
          case "error":
            return Response.json({ error: { code: "maxlag" } });
          case "html":
            return new Response("<html>Just a moment…</html>");
        }
        return Response.json({
          query: {
            pages: titles.map((title) => {
              const [c] = byPage.get(title);
              if (wiki.apiBroken === "missing") return { title, missing: true };
              return {
                title,
                revisions: [{ slots: { main: { content: c.wikitext } } }],
                categories: c.categories.map((t) => ({ title: t })),
              };
            }),
          },
        });
      }
      const slug = url.slice("https://images.test/".length, -".png".length);
      wiki.inFlight++;
      wiki.maxInFlight = Math.max(wiki.maxInFlight, wiki.inFlight);
      try {
        // A turn of the event loop, as a real request takes, so the
        // requests in flight overlap.
        await new Promise((resolve) => setImmediate(resolve));
        if (wiki.hold) {
          await new Promise((resolve, reject) => {
            wiki.held.push(resolve);
            init.signal?.addEventListener("abort", () =>
              reject(init.signal.reason),
            );
          });
        }
        const face = bySlug.get(slug).face;
        switch (wiki.broken.get(slug)) {
          case "network":
            throw new TypeError("fetch failed");
          case "status":
            return new Response("busy", { status: 503 });
          case "corrupt":
            return new Response(Buffer.alloc(face.length, "x"));
          case "short":
            return new Response(face.subarray(1));
          default:
            return new Response(face);
        }
      } finally {
        wiki.inFlight--;
      }
    },
  };
  return wiki;
}

function town(characters = TOWN, dir = freshDir()) {
  const wiki = fakeWiki(characters);
  const manifest = manifestFor(characters);
  const data = createVillagerData({
    dir: () => dir,
    manifest,
    fetch: wiki.fetch,
  });
  return { dir, wiki, manifest, data, characters };
}

async function doneReaches(data, count) {
  await waitFor(
    async () => (await data.status()).done === count,
    `done ${count}`,
  );
}

try {
  await proof.check(
    "a download stores every profile and face, counts each villager once both are in, and appears whole",
    async () => {
      const { dir, wiki, data, characters } = town();
      wiki.hold = true;
      assert.deepEqual(await data.start(), {
        kind: "downloading",
        done: 0,
        villagers: 7,
      });
      await waitFor(() => wiki.held.length === 4, "four in flight");
      // Profiles are in, no face yet: nobody counts.
      assert.equal((await data.status()).done, 0);
      assert.ok(!existsSync(join(dir, "ready")), "ready before the end");
      assert.equal(await data.profiles(), null);
      assert.equal(await data.face("ace"), null);

      wiki.release(1);
      await doneReaches(data, 1);
      wiki.release(2);
      await doneReaches(data, 3);
      wiki.releaseAll();
      await data.settled();

      const status = await data.status();
      assert.equal(status.kind, "ready");
      assert.equal(status.villagers, 7);
      assert.ok(!Number.isNaN(Date.parse(status.downloadedAt)));
      assert.ok(!existsSync(join(dir, "partial")), "partial/ left behind");
      assert.equal(readdirSync(join(dir, "ready", "faces")).length, 7);

      assert.deepEqual(
        await Promise.all(characters.map((c) => data.face(c.slug))),
        characters.map((c) => c.face.toString("base64")),
      );
      const profiles = await data.profiles();
      assert.deepEqual(
        profiles.ace,
        villagerProfile("ace", {
          title: "Ace",
          wikitext: characters[0].wikitext,
          categories: ["Category:Villagers"],
        }),
      );
      assert.equal(profiles.ace.birthday, "03-04");
      assert.equal(profiles.isabelle.kind, "special");
      assert.equal(profiles.tommy.name, "Tommy");
      assert.equal(await data.face("not-a-villager"), null);
      assert.equal(await data.face("__proto__"), null);

      // One API request for the seven, with the lead section only.
      const [api, ...more] = wiki.apiRequests();
      assert.equal(more.length, 0);
      assert.equal(new URL(api.url).searchParams.get("rvsection"), "0");
      assert.ok(wiki.requests.every((r) => r.userAgent === WIKI_USER_AGENT));
      assert.equal(wiki.faceRequests().length, 7);
    },
  );

  await proof.check("a second run is a no-op", async () => {
    const { wiki, data } = town();
    await data.start();
    await data.settled();
    const asked = wiki.requests.length;
    const again = await data.start();
    await data.settled();
    assert.equal(again.kind, "ready");
    assert.equal(wiki.requests.length, asked, "the second run asked the wiki");
  });

  await proof.check(
    "a face that doesn't match is refused, and trying again resumes",
    async () => {
      const refusedThenResumed = async (broken) => {
        const { dir, wiki, data } = town();
        wiki.broken.set("carmen", broken);
        await data.start();
        await data.settled();
        const failed = await data.status();
        assert.equal(failed.kind, "failed", broken);
        assert.equal(
          failed.message,
          "Carmen's face didn't match what Nookipedia lists.",
        );
        assert.ok(failed.done < 7);
        assert.ok(!existsSync(join(dir, "ready")));
        assert.ok(!existsSync(join(dir, "partial", "faces", "carmen.png")));
        assert.equal(await data.face("ace"), null, "a partial face served");

        wiki.broken.clear();
        const before = wiki.requests.length;
        const stored = readdirSync(join(dir, "partial", "faces")).length;
        await data.start();
        await data.settled();
        assert.equal((await data.status()).kind, "ready");
        const resumed = wiki.requests.slice(before);
        assert.ok(
          resumed.every((r) => !r.url.startsWith(WIKI_API)),
          "the profiles were asked for again",
        );
        assert.equal(
          resumed.length,
          7 - stored,
          "stored faces were fetched again",
        );
      };
      await Promise.all(["corrupt", "short"].map(refusedThenResumed));
    },
  );

  await proof.check(
    "a download the app never finished reads as failed and resumes",
    async () => {
      const first = town();
      first.wiki.broken.set("zucker", "network");
      await first.data.start();
      await first.data.settled();
      const stored = (await first.data.status()).done;

      // A new process over the same folder has no reason on record.
      const later = town(TOWN, first.dir);
      assert.deepEqual(await later.data.status(), {
        kind: "failed",
        done: stored,
        villagers: 7,
        message: "The download was interrupted.",
      });
      await later.data.start();
      await later.data.settled();
      assert.equal((await later.data.status()).kind, "ready");
      assert.equal(later.wiki.apiRequests().length, 0);
    },
  );

  await proof.check("cancel stops and drops what it stored", async () => {
    const { dir, wiki, data } = town();
    wiki.hold = true;
    await data.start();
    await waitFor(() => wiki.held.length === 4, "four in flight");
    wiki.release(1);
    await doneReaches(data, 1);
    assert.deepEqual(await data.cancel(), {
      kind: "absent",
      villagers: 7,
    });
    assert.ok(!existsSync(join(dir, "partial")));
    assert.ok(!existsSync(join(dir, "ready")));
  });

  await proof.check(
    "network and HTTP failures read in the product's words",
    async () => {
      const failsWith = async (broken, message) => {
        const { wiki, data } = town();
        if (broken.startsWith("api ")) wiki.apiBroken = broken.slice(4);
        else wiki.broken.set("ace", broken);
        await data.start();
        await data.settled();
        const status = await data.status();
        assert.equal(status.kind, "failed");
        assert.equal(status.message, message);
      };
      await Promise.all([
        failsWith("network", "Couldn't reach Nookipedia."),
        failsWith("status", "Nookipedia answered with an error (503)."),
        failsWith("api error", "Nookipedia answered with an error (maxlag)."),
        failsWith("api html", "Nookipedia answered unexpectedly."),
        failsWith("api missing", "Nookipedia has no page Ace."),
      ]);
    },
  );

  await proof.check(
    "damaged data reads as not there and downloads again",
    async () => {
      const { dir, wiki, data } = town();
      await data.start();
      await data.settled();
      writeFileSync(join(dir, "ready", "meta.json"), "{");
      assert.deepEqual(await data.status(), { kind: "absent", villagers: 7 });
      await data.start();
      await data.settled();
      assert.equal((await data.status()).kind, "ready");
      assert.equal(wiki.faceRequests().length, 14);
    },
  );

  await proof.check("remove clears it all, mid-download too", async () => {
    const absent = { kind: "absent", villagers: 7 };
    const { dir, data } = town();
    await data.start();
    await data.settled();
    assert.deepEqual(await data.remove(), absent);
    assert.ok(!existsSync(dir));
    assert.equal(await data.face("ace"), null);
    assert.equal(await data.profiles(), null);

    const busy = town();
    busy.wiki.hold = true;
    await busy.data.start();
    await waitFor(() => busy.wiki.held.length > 0, "in flight");
    assert.deepEqual(await busy.data.remove(), absent);
    assert.ok(!existsSync(busy.dir));
  });

  await proof.check(
    "the wiki is asked 50 pages at a time, four faces at a time",
    async () => {
      const crowd = Array.from({ length: 120 }, (_, i) =>
        character(`V${String(i).padStart(3, "0")}`, { size: 40 }),
      );
      const { wiki, data } = town(crowd);
      await data.start();
      await data.settled();
      assert.equal((await data.status()).kind, "ready");
      const batches = wiki
        .apiRequests()
        .map(
          (r) => new URL(r.url).searchParams.get("titles").split("|").length,
        );
      assert.deepEqual(batches, [50, 50, 20]);
      assert.equal(wiki.maxInFlight, 4);
      assert.equal(wiki.faceRequests().length, 120);
    },
  );

  await proof.check("Village life opens only with names and the data", () => {
    const flair =
      "Your villagers come to life with a little extra flair around the app. Purely cosmetic.";
    const ready = { kind: "ready", downloadedAt: "", villagers: 499 };
    assert.deepEqual(villageLifeRow(true, ready), {
      locked: false,
      description: flair,
    });
    for (const status of [
      { kind: "absent", villagers: 499 },
      { kind: "downloading", done: 212, villagers: 499 },
      { kind: "failed", done: 212, villagers: 499, message: "" },
    ]) {
      assert.deepEqual(villageLifeRow(true, status), {
        locked: true,
        description: `${flair} Download villager data from Nookipedia to turn it on.`,
      });
    }
    // Names off comes first, whatever the data.
    for (const status of [ready, { kind: "absent", villagers: 499 }]) {
      assert.deepEqual(villageLifeRow(false, status), {
        locked: true,
        description: `${flair} Turn on Doubutsu names to use it.`,
      });
    }
    // Still loading: locked, and pointing nowhere yet.
    assert.deepEqual(villageLifeRow(true, undefined), {
      locked: true,
      description: flair,
    });
  });

  await proof.check("the Settings line for every state", () => {
    assert.deepEqual(villagerDataView({ kind: "absent", villagers: 499 }), {
      action: "download",
    });
    assert.deepEqual(
      villagerDataView({ kind: "downloading", done: 212, villagers: 499 }),
      {
        text: "Downloading… 212 of 499",
        action: "cancel",
        progress: 212 / 499,
      },
    );
    const downloadedAt = new Date().toISOString();
    const day = new Date(downloadedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    assert.deepEqual(
      villagerDataView({ kind: "ready", downloadedAt, villagers: 499 }),
      { text: `Downloaded ${day}`, action: "remove" },
    );
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    assert.match(
      villagerDataView({
        kind: "ready",
        downloadedAt: lastYear.toISOString(),
        villagers: 499,
      }).text,
      new RegExp(String(lastYear.getFullYear())),
    );
    const failed = {
      kind: "failed",
      done: 212,
      villagers: 499,
      message: "Couldn't reach Nookipedia.",
    };
    assert.deepEqual(villagerDataView(failed), {
      text: "Stopped at 212 of 499. Couldn't reach Nookipedia.",
      action: "retry",
    });
    assert.deepEqual(villagerDataView({ ...failed, done: 0 }), {
      text: "Couldn't reach Nookipedia.",
      action: "retry",
    });
  });

  proof.done();
} catch (error) {
  proof.fail(error);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
