// The villagers the fixtures know without the downloaded villager
// data (villager-data/, gitignored): the visits the fake host poses,
// and a few profiles, enough for a picture of the album with no
// download behind it (../scenes).
import type {
  VillagerProfile,
  VillagerProfiles,
} from "@shigomori/contracts/schemas";

// A spread of visits for the Visitors album: slug, times, and the days
// ago of the first and last.
// Frillard and Lloid carry the longest species and a wiki-flavored one,
// for the back of a card.
export const DAY = 24 * 60 * 60_000;
export const FAKE_VISITS: [string, number, number, number][] = [
  ["raymond", 17, 200, 1],
  ["marshal", 6, 150, 9],
  ["judy", 4, 120, 30],
  ["sherb", 3, 90, 12],
  ["stitches", 3, 140, 22],
  ["sheldon", 5, 170, 3],
  ["ankha", 2, 80, 40],
  ["zucker", 2, 75, 5],
  ["dom", 2, 90, 30],
  ["fauna", 2, 64, 21],
  ["bob", 1, 2, 2],
  ["audie", 1, 60, 60],
  ["lolly", 1, 4, 4],
  ["maple", 1, 200, 200],
  ["ketchup", 1, 11, 11],
  ["molly", 1, 25, 25],
  ["ace", 1, 1, 1],
  ["tom-nook", 2, 180, 20],
  ["isabelle", 3, 160, 7],
  ["kk-slider", 1, 3, 3],
  ["celeste", 1, 50, 50],
  ["pascal", 1, 6, 6],
  ["katrina", 1, 45, 45],
  ["leif", 2, 100, 14],
  ["daisy-mae", 2, 70, 16],
  ["frillard", 1, 33, 33],
  ["lloid", 1, 75, 75],
];

const profile = (
  name: string,
  fields: Omit<VillagerProfile, "name" | "url">,
): VillagerProfile => ({
  name,
  url: `https://nookipedia.com/wiki/${name.replace(/ /g, "_")}`,
  ...fields,
});

export const FAKE_VILLAGER_PROFILES: VillagerProfiles = {
  raymond: profile("Raymond", {
    kind: "villager",
    species: "Cat",
    personality: "Smug",
    birthday: "10-01",
    catchphrase: "crisp",
  }),
  marshal: profile("Marshal", {
    kind: "villager",
    species: "Squirrel",
    personality: "Smug",
    birthday: "09-29",
    catchphrase: "sulky",
  }),
  judy: profile("Judy", {
    kind: "villager",
    species: "Cub",
    personality: "Snooty",
    birthday: "03-10",
    catchphrase: "myohmy",
  }),
  sherb: profile("Sherb", {
    kind: "villager",
    species: "Goat",
    personality: "Lazy",
    birthday: "01-18",
    catchphrase: "bawwww",
  }),
  bob: profile("Bob", {
    kind: "villager",
    species: "Cat",
    personality: "Lazy",
    birthday: "01-01",
    catchphrase: "pthhpth",
  }),
  frillard: profile("Frillard", {
    kind: "villager",
    species: "Frilled lizard",
    personality: "Smug",
  }),
  lolly: profile("Lolly", {
    kind: "villager",
    species: "Cat",
    personality: "Normal",
    birthday: "03-27",
    catchphrase: "bonbon",
  }),
  "daisy-mae": profile("Daisy Mae", { kind: "special", species: "Boar" }),
  leif: profile("Leif", { kind: "special", species: "Sloth" }),
  lloid: profile("Lloid", { kind: "special", species: "Gyroid" }),
  katrina: profile("Katrina", { kind: "special", species: "Panther" }),
  "tom-nook": profile("Tom Nook", {
    kind: "special",
    species: "Tanuki",
    quote: "Yes, yes!",
  }),
  isabelle: profile("Isabelle", { kind: "special", species: "Shih Tzu" }),
  "kk-slider": profile("K.K. Slider", { kind: "special", species: "Dog" }),
  celeste: profile("Celeste", { kind: "special", species: "Owl" }),
  blathers: profile("Blathers", { kind: "special", species: "Owl" }),
};

// The visits as the album counts them, by slug: how many, and the
// first and last, in epoch ms.
export function fakeVisitTally(
  now = Date.now(),
): Map<string, { count: number; first: number; last: number }> {
  return new Map(
    FAKE_VISITS.map(([slug, count, first, last]) => [
      slug,
      { count, first: now - first * DAY, last: now - last * DAY },
    ]),
  );
}
