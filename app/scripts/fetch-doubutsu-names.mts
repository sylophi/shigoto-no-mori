// Fetches every Animal Crossing villager and special character from
// Nookipedia (the community wiki) and writes three files:
//
//   assets/doubutsu-characters.json    every character, with metadata
//                                      (species, personality, birthday,
//                                      localized names, games, ...)
//   shared/villagers/manifest.json     where each character's face icon
//                                      lives on the wiki (references
//                                      only, no images)
//   cli/embed/doubutsu-names.json      the slugged names the worktree
//                                      name picker draws from: the
//                                      characters with a face
//
// The lists come from the wiki's Category:Villagers and
// Category:Special characters through its public MediaWiki API (no key
// needed), and each page's infobox supplies the metadata. Re-run it when
// a new game or update adds characters, then review the diff.
//
// Run: node scripts/fetch-doubutsu-names.mts

/* oxlint-disable no-await-in-loop -- one request at a time on purpose,
   to go easy on a community wiki's API. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isValidWorktreeDirName } from "../shared/git/branches.ts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

const API = "https://nookipedia.com/w/api.php";
const WIKI = "https://nookipedia.com/wiki/";
const USER_AGENT = "shigoto-no-mori/doubutsu-names (github.com/sylophi)";

// Category members that are not characters with a name of their own:
// concept pages, the player, a placeholder puppet, an unused internal ID.
const EXCLUDED = new Set([
  "Starting villager",
  "Player",
  "Parents",
  "Somebody",
  "Special character",
  "Xsq",
]);

// One page covering two characters, split into one name each.
const SPLIT: Record<string, string[]> = {
  "Timmy and Tommy": ["Timmy", "Tommy"],
};

// Infobox fields that only style the wiki page.
const PRESENTATION_FIELDS = new Set([
  "titlecolor",
  "textcolor",
  "image",
  "imagesize",
  "caption",
]);

type Kind = "villager" | "special";

interface Character {
  slug: string;
  name: string;
  kind: Kind;
  page: string;
  url: string;
  species?: string;
  gender?: string;
  personality?: string;
  birthday?: string;
  sign?: string;
  catchphrase?: string;
  quote?: string;
  japaneseName?: string;
  japaneseNameRomaji?: string;
  englishLocalization: boolean;
  debut?: string;
  games: string[];
  infobox: Record<string, string>;
  categories: string[];
}

async function api(params: Record<string, string>): Promise<any> {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (response.ok) return response.json();
    if (attempt >= 4) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    await sleep(1000 * attempt);
  }
}

// Follows MediaWiki's `continue` tokens until the query is exhausted.
async function* paged(params: Record<string, string>): AsyncGenerator<any> {
  let cont: Record<string, string> = {};
  for (;;) {
    const data = await api({ ...params, ...cont });
    yield data;
    if (!data.continue) return;
    cont = data.continue;
    await sleep(250);
  }
}

async function categoryPages(category: string): Promise<string[]> {
  const titles: string[] = [];
  for await (const data of paged({
    action: "query",
    list: "categorymembers",
    cmtitle: category,
    cmtype: "page",
    cmlimit: "500",
  })) {
    for (const member of data.query.categorymembers) titles.push(member.title);
  }
  return titles;
}

interface Page {
  wikitext: string;
  categories: string[];
}

async function pages(titles: string[]): Promise<Map<string, Page>> {
  const out = new Map<string, Page>();
  for (let i = 0; i < titles.length; i += 25) {
    const batch = titles.slice(i, i + 25);
    for await (const data of paged({
      action: "query",
      prop: "revisions|categories",
      rvprop: "content",
      rvslots: "main",
      cllimit: "max",
      titles: batch.join("|"),
    })) {
      for (const page of data.query.pages) {
        const entry = out.get(page.title) ?? { wikitext: "", categories: [] };
        const content = page.revisions?.[0]?.slots?.main?.content;
        if (content) entry.wikitext = content;
        for (const category of page.categories ?? []) {
          entry.categories.push(category.title.replace(/^Category:/, ""));
        }
        out.set(page.title, entry);
      }
    }
    process.stderr.write(
      `  ${Math.min(i + 25, titles.length)}/${titles.length}\n`,
    );
  }
  return out;
}

// Splits `text` on `separator` wherever it sits outside {{ }} and [[ ]].
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === "{{" || pair === "[[") {
      depth++;
      i++;
    } else if (pair === "}}" || pair === "]]") {
      depth--;
      i++;
    } else if (depth === 0 && text[i] === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// The body of the page's first `{{Infobox ...}}`, as field → raw value.
function infobox(wikitext: string): Record<string, string> {
  const start = wikitext.search(/\{\{\s*Infobox/i);
  if (start < 0) return {};
  let depth = 0;
  let end = start;
  for (; end < wikitext.length; end++) {
    const pair = wikitext.slice(end, end + 2);
    if (pair === "{{") depth++;
    else if (pair === "}}") depth--;
    else continue;
    end++;
    if (depth === 0) break;
  }
  const body = wikitext.slice(start + 2, end - 1);
  const fields: Record<string, string> = {};
  for (const part of splitTopLevel(body, "|").slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = clean(part.slice(eq + 1));
    if (key && value && value !== "N/A" && !PRESENTATION_FIELDS.has(key)) {
      fields[key] = value;
    }
  }
  return fields;
}

// Wikitext to plain text: drops refs, notes and comments, keeps link
// labels, and turns line breaks into "; ".
function clean(value: string): string {
  let text = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/<br\s*\/?>/gi, "; ");
  // Innermost templates first, so nested ones collapse outward.
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => {
      const [name, ...args] = inner.split("|").map((s) => s.trim());
      if (/^(note|efn|clear)$/i.test(name)) return "";
      const positional = args.find(
        (a) => !a.includes("=") && a !== "short" && a !== "nolink",
      );
      return positional ?? name;
    });
  }
  return text
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// "Carmen (mouse)" → "Carmen": the wiki disambiguates, the game doesn't.
function displayName(title: string): string {
  return title.replace(/\s*\([^)]*\)$/, "");
}

// Category names that end in " characters" but are not a game.
const NON_GAME_CATEGORY =
  /^(Male|Female|Removed|Cut|Special|New characters in|Characters with) |^Characters$/;

// Wiki housekeeping, not facts about the character.
const MAINTENANCE_CATEGORY = /^(Pages|Articles) with /;

function describe(
  title: string,
  name: string,
  kind: Kind,
  page: Page,
): Character {
  const box = infobox(page.wikitext);
  const games = page.categories
    .filter((c) => c.endsWith(" characters") && !NON_GAME_CATEGORY.test(c))
    .map((c) => c.slice(0, -" characters".length))
    .toSorted();
  const debut = page.categories
    .find((c) => c.startsWith("New characters in "))
    ?.slice("New characters in ".length);
  const birthday =
    box.birthdaymonth && box.birthday
      ? `${box.birthdaymonth} ${box.birthday}`
      : undefined;
  return {
    slug: slugify(name),
    name,
    kind,
    page: title,
    url: WIKI + encodeURIComponent(title.replaceAll(" ", "_")),
    species: box.species,
    gender: box.gender,
    personality: box.personality,
    birthday,
    sign: box.sign,
    catchphrase: box.phrase,
    quote: box.quote,
    japaneseName: box["ja-name"],
    japaneseNameRomaji: box["ja-name-r"],
    englishLocalization: box["no-localization"] !== "Yes",
    debut,
    games,
    infobox: box,
    categories: page.categories
      .filter((c) => !MAINTENANCE_CATEGORY.test(c))
      .toSorted(),
  };
}

async function collect(category: string, kind: Kind): Promise<Character[]> {
  process.stderr.write(`${category}\n`);
  const titles = (await categoryPages(category)).filter(
    (t) => !EXCLUDED.has(t),
  );
  const fetched = await pages(titles);
  return titles.flatMap((title) => {
    const page = fetched.get(title);
    if (!page) throw new Error(`No page data for ${title}`);
    const names = SPLIT[title] ?? [displayName(title)];
    return names.map((name) => describe(title, name, kind, page));
  });
}

const villagers = await collect("Category:Villagers", "villager");
const specials = await collect("Category:Special characters", "special");

// Two villagers can share a name across games (Carmen the rabbit and
// Carmen the mouse). The picker needs each slug once, and the metadata
// keeps both.
const characters = [...villagers, ...specials].toSorted(
  (a, b) => a.slug.localeCompare(b.slug) || a.page.localeCompare(b.page),
);
// Each name can become a folder and a branch, so fail before writing
// anything that isn't plain kebab-case or that the app would refuse.
for (const { slug } of characters) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || !isValidWorktreeDirName(slug))
    throw new Error(`Bad slug: ${slug}`);
}

// ---- faces ----
//
// Each character's face icon, as the wiki files it: the manifest
// records the file, its description page (where the file's own credits
// live), the image's URL, size and sha1. Nothing is downloaded here:
// the app fetches the images when its user asks (host/lib/villagers)
// and checks each against this record. Several games drew faces, so
// each character tries the file names below in order and keeps the
// first that exists at its game's size, and a few characters the
// patterns miss name their file by hand. Characters from games that
// never had one (the GameCube villagers who never came back, a few
// specials) get none, are listed as missing, and stay out of the name
// pool, so every name a worktree can be given has a face.

// The wiki's file names for a face icon, best first: New Horizons, then
// Pocket Camp, then New Leaf. Villagers and special characters are
// filed under different names.
const PATTERNS = [
  "NH Villager Icon",
  "PC Villager Icon",
  "NH Character Icon",
  "PC Character Icon",
  "NL Villager Icon",
];

// Characters none of the patterns find, and the file that is their face
// icon, each picked by hand on the wiki. They replace the patterns for
// that slug, and one that stops resolving fails the run.
const OVERRIDES: Record<string, string> = {
  // His only flat face icon is the NH question (hint) one.
  "kk-slider": "File:K.K. Slider NH Question Icon.png",
  // Filed under a shorter name than their page.
  "zipper-t-bunny": "File:Zipper NH Character Icon.png",
  "dr-shrunk": "File:Shrunk NH Character Icon.png",
  // City Folk's rendered icons, the only ones they have.
  serena: "File:Serena CF Character Icon.png",
  frillard: "File:Frillard CF Character Icon.png",
  // Happy Home Designer's, likewise.
  snowboy: "File:Snowboy HHD Character Icon.png",
  snowmam: "File:Snowmam HHD Character Icon.png",
  snowtyke: "File:Snowtyke HHD Character Icon.png",
};

// The square size each kind of file is drawn at. A file of another size
// is a different crop (some Pocket Camp ones are 72x72) and loses to the
// next pattern.
const EDGES: Record<string, number> = {
  "NH Villager Icon": 128,
  "PC Villager Icon": 128,
  "NH Character Icon": 128,
  "PC Character Icon": 128,
  "NL Villager Icon": 64,
  "NH Question Icon": 256,
  "CF Character Icon": 128,
  "HHD Character Icon": 64,
};

function edge(title: string): number | undefined {
  const kind = Object.keys(EDGES).find((k) => title.endsWith(` ${k}.png`));
  return kind === undefined ? undefined : EDGES[kind];
}

interface Icon {
  // The wiki file title, e.g. "File:Ace NH Villager Icon.png".
  file: string;
  // Its description page.
  filePage: string;
  // The image itself, and what it must be.
  image: string;
  bytes: number;
  sha1: string;
}

// The file titles to try for a character, best first. The name as well
// as the page: Timmy and Tommy share a page but each has an icon.
function faceCandidates(character: Character): string[] {
  const override = OVERRIDES[character.slug];
  if (override !== undefined) return [override];
  const bases = [...new Set([character.page, character.name])];
  return PATTERNS.flatMap((pattern) =>
    bases.map((base) => `File:${base} ${pattern}.png`),
  );
}

// Which of `titles` exist at their game's size, 50 to a request (the
// API's cap).
async function resolveFaces(titles: string[]): Promise<Map<string, Icon>> {
  const found = new Map<string, Icon>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const data = await api({
      action: "query",
      prop: "imageinfo",
      iiprop: "url|sha1|size",
      titles: batch.join("|"),
    });
    const asked = new Map<string, string>();
    for (const { from, to } of data.query.normalized ?? []) asked.set(to, from);
    for (const page of data.query.pages) {
      const info = page.imageinfo?.[0];
      if (page.missing || info === undefined) continue;
      const file = asked.get(page.title) ?? page.title;
      const size = edge(file);
      if (info.width !== size || info.height !== size) continue;
      found.set(file, {
        file,
        filePage: info.descriptionurl,
        image: info.url,
        bytes: info.size,
        sha1: info.sha1,
      });
    }
    process.stderr.write(
      `  ${Math.min(i + 50, titles.length)}/${titles.length} face files\n`,
    );
    await sleep(250);
  }
  return found;
}

// A slug two characters share goes to the one whose page is the bare
// name, the one the wiki considers the main one.
const bySlug = new Map<string, Character>();
for (const character of characters) {
  const held = bySlug.get(character.slug);
  if (held === undefined || character.page === character.name) {
    bySlug.set(character.slug, character);
  }
}
for (const slug of Object.keys(OVERRIDES)) {
  if (!bySlug.has(slug)) {
    throw new Error(`Override for ${slug}, which is not a character`);
  }
}
process.stderr.write(`Resolving faces for ${bySlug.size} characters\n`);
const tries = new Map(
  [...bySlug].map(([slug, character]) => [slug, faceCandidates(character)]),
);
const found = await resolveFaces([...new Set([...tries.values()].flat())]);
const withFace: Record<string, { page: string; icon: Icon }> = {};
const missing: string[] = [];
for (const [slug, titles] of tries) {
  const file = titles.find((title) => found.has(title));
  if (file === undefined) {
    if (slug in OVERRIDES) {
      throw new Error(`${slug}: ${OVERRIDES[slug]} is gone or resized`);
    }
    missing.push(slug);
    continue;
  }
  withFace[slug] = { page: bySlug.get(slug)!.page, icon: found.get(file)! };
}
const names = Object.keys(withFace);

// ---- writing ----

const today = new Date().toISOString().slice(0, 10);
const namesPath = join(repoRoot, "cli", "embed", "doubutsu-names.json");
const manifestPath = join(appRoot, "shared", "villagers", "manifest.json");
const charactersPath = join(appRoot, "assets", "doubutsu-characters.json");

// A file's retrieved date moves only when what it records did, so a
// re-run that finds nothing new leaves no diff.
function retrieved(path: string, body: object): string {
  if (!existsSync(path)) return today;
  const { source, ...held } = JSON.parse(readFileSync(path, "utf8"));
  return JSON.stringify(held) === JSON.stringify(body)
    ? source.retrieved
    : today;
}

const source = {
  name: "Nookipedia",
  url: "https://nookipedia.com/",
  license: "CC-BY-SA-4.0",
  categories: ["Category:Villagers", "Category:Special characters"],
};
const pool = { names };
const manifest = { villagers: withFace, missing };
writeFileSync(
  namesPath,
  JSON.stringify({
    source: { ...source, retrieved: retrieved(namesPath, pool) },
    ...pool,
  }),
);
writeFileSync(
  manifestPath,
  JSON.stringify({
    source: {
      name: source.name,
      url: source.url,
      retrieved: retrieved(manifestPath, manifest),
    },
    ...manifest,
  }),
);
writeFileSync(
  charactersPath,
  JSON.stringify({ source: { ...source, retrieved: today }, characters }),
);
// The repo's formatter owns the layout, so a re-run diffs cleanly.
execFileSync(
  "pnpm",
  ["exec", "oxfmt", namesPath, manifestPath, charactersPath],
  { cwd: appRoot, stdio: "inherit" },
);
process.stderr.write(
  `${villagers.length} villagers, ${specials.length} special characters, ${bySlug.size} names, ${names.length} with a face in the pool\n`,
);
