// Reading Nookipedia, the community wiki the doubutsu names and the
// villager data come from. One module for both of its readers: the
// maintainer script that refreshes the name pool and the manifest
// (scripts/fetch-doubutsu-names.mts) and the app's on-request download
// of the villager data (host/lib/villagers.ts). Pure: the readers do
// the fetching.
//
// Type-only imports, so plain node can load this file from the script.
import type { VillagerKind, VillagerProfile } from "../schemas/villagers";

export const WIKI_API = "https://nookipedia.com/w/api.php";
const WIKI_PAGE = "https://nookipedia.com/wiki/";
// How both readers introduce themselves to the wiki.
export const WIKI_USER_AGENT =
  "shigoto-no-mori/doubutsu-names (github.com/sylophi)";

// The two categories the characters come from. A page in the first is
// a villager, one only in the second a special character.
export const CHARACTER_CATEGORIES = [
  "Category:Villagers",
  "Category:Special characters",
] as const;

export function wikiPageUrl(title: string): string {
  return WIKI_PAGE + encodeURIComponent(title.replaceAll(" ", "_"));
}

// ---- names ----

// One page covering two characters, split into one name each.
const SPLIT: Readonly<Record<string, readonly string[]>> = {
  "Timmy and Tommy": ["Timmy", "Tommy"],
};

// The characters a page covers, by the names the games use: "Carmen
// (mouse)" is Carmen, since the wiki disambiguates and the game doesn't.
export function namesOnPage(title: string): readonly string[] {
  return SPLIT[title] ?? [title.replace(/\s*\([^)]*\)$/, "")];
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// One character per slug. Two can share one (Carmen the rabbit and
// Carmen the mouse): the one whose page is the bare name, the one the
// wiki considers the main one, keeps it.
export function oneBySlug<
  T extends { slug: string; name: string; page: string },
>(characters: readonly T[]): Map<string, T> {
  const bySlug = new Map<string, T>();
  for (const character of characters) {
    const held = bySlug.get(character.slug);
    if (held === undefined || character.page === character.name) {
      bySlug.set(character.slug, character);
    }
  }
  return bySlug;
}

// ---- the infobox ----

// Infobox fields that only style the wiki page.
const PRESENTATION_FIELDS = new Set([
  "titlecolor",
  "textcolor",
  "image",
  "imagesize",
  "caption",
]);

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

// The body of the page's first `{{Infobox ...}}`, as field → plain
// text. Empty fields, "N/A" and the page styling are left out.
export function infobox(wikitext: string): Record<string, string> {
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

// ---- the villager profile ----

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// "August" and "11" as "08-11", or undefined when either is missing or
// not a date.
function birthday(month?: string, day?: string): string | undefined {
  const m = MONTHS.indexOf(month?.toLowerCase() ?? "") + 1;
  const d = Number(day);
  if (m === 0 || !Number.isInteger(d) || d < 1 || d > 31) return undefined;
  return `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface WikiPage {
  title: string;
  wikitext: string;
  // The page's categories, as "Category:..." titles.
  categories: readonly string[];
}

// What a character's page says about the character with this slug:
// whatever its infobox has of the profile's fields. A field the page
// lacks is left out. A page two characters share (Timmy and Tommy)
// splits a field written "A & B" between them, and gives each the
// quote the page credits to them.
export function villagerProfile(slug: string, page: WikiPage): VillagerProfile {
  const names = namesOnPage(page.title);
  const index = Math.max(
    0,
    names.findIndex((name) => slugify(name) === slug),
  );
  const name = names[index];
  const box = infobox(page.wikitext);
  const own = (value: string | undefined): string | undefined => {
    if (value === undefined || names.length === 1) return value;
    const parts = value.split(" & ");
    return parts.length === names.length ? parts[index] : value;
  };
  const quoteKey =
    ["quote", "quote2", "quote3"].find(
      (key) => box[`${key}-character`] === name,
    ) ?? "quote";
  const kind: VillagerKind = page.categories.includes(CHARACTER_CATEGORIES[0])
    ? "villager"
    : "special";
  const profile: VillagerProfile = {
    name,
    kind,
    species: box.species,
    personality: box.personality,
    gender: box.gender,
    birthday: birthday(box.birthdaymonth, box.birthday),
    sign: box.sign,
    catchphrase: box.phrase,
    quote: box[quoteKey],
    japaneseName: own(box["ja-name"]),
    japaneseNameRomaji: own(box["ja-name-r"]),
    url: wikiPageUrl(page.title),
  };
  // Leave out what the page doesn't say, rather than store undefined.
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined),
  ) as VillagerProfile;
}
